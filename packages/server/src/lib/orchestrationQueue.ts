import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';

// The queue table name — fixed by the model's @Table decorator.
const RUN_TASK_TABLE = 'orchestration_run_tasks';

const log = createDebug('soat:orchestrations');

const DEFAULT_TASK_LEASE_TTL_MS = 60_000; // 1 minute

/**
 * How long a claimed task's lease is valid before it may be redelivered. It
 * only needs to exceed the time driving a run to its next resting point takes;
 * a worker that finishes `ack`s (deletes) the task well before then.
 * Configurable via `ORCHESTRATION_TASK_LEASE_TTL_MS`.
 */
export const taskLeaseTtlMs = (): number => {
  const configured = Number(process.env.ORCHESTRATION_TASK_LEASE_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TASK_LEASE_TTL_MS;
};

export type RunTaskKind = 'continue' | 'wake' | 'resume';

export type RunTaskInstance = InstanceType<typeof db.OrchestrationRunTask>;

/**
 * Enqueues a task for a run. `availableAt` in the future parks the task until
 * then (used for backoff / scheduled availability); omitted, it is claimable
 * immediately. Returns the created task row.
 */
export const enqueueRunTask = async (args: {
  runId: number;
  kind: RunTaskKind;
  availableAt?: Date;
}): Promise<RunTaskInstance> => {
  log('enqueueRunTask: runId=%d kind=%s', args.runId, args.kind);
  return db.OrchestrationRunTask.create({
    runId: args.runId,
    kind: args.kind,
    availableAt: args.availableAt ?? new Date(),
    attempts: 0,
  });
};

/**
 * Claims up to `limit` due tasks using `SELECT … FOR UPDATE SKIP LOCKED`, then
 * marks them claimed (setting the lease and incrementing `attempts`) — all in
 * one transaction so two workers racing the same tick never claim the same
 * task. A task is due when `available_at <= now` and it is either unclaimed or
 * its previous lease has expired (redelivery).
 *
 * Returns the claimed task rows, freshly reloaded with their new lease.
 */
export const claimRunTasks = async (args: {
  limit: number;
  now?: Date;
}): Promise<RunTaskInstance[]> => {
  const now = args.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + taskLeaseTtlMs());
  const sequelize = db.sequelize;

  const claimedIds = await sequelize.transaction(async (transaction) => {
    // FOR UPDATE SKIP LOCKED skips rows another transaction has already locked,
    // so concurrent claimers partition the due set instead of contending.
    // Raw SQL references the physical (snake_case) columns — the models use
    // `underscored`, so the `availableAt` attribute is the `available_at` column.
    const [rows] = await sequelize.query(
      `SELECT "id" FROM "${RUN_TASK_TABLE}"
       WHERE "available_at" <= :now
         AND ("claimed_at" IS NULL OR "lease_expires_at" < :now)
       ORDER BY "available_at" ASC
       LIMIT :limit
       FOR UPDATE SKIP LOCKED`,
      { replacements: { now, limit: args.limit }, transaction }
    );

    const ids = (rows as Array<{ id: number }>).map((r) => {
      return r.id;
    });
    if (ids.length === 0) return ids;

    await db.OrchestrationRunTask.update(
      {
        claimedAt: now,
        leaseExpiresAt,
        attempts: sequelize.literal('"attempts" + 1'),
      },
      { where: { id: { [Op.in]: ids } }, transaction }
    );
    return ids;
  });

  if (claimedIds.length === 0) return [];

  const tasks = await db.OrchestrationRunTask.findAll({
    where: { id: { [Op.in]: claimedIds } },
  });
  log('claimRunTasks: claimed %d task(s)', tasks.length);
  return tasks;
};

/**
 * Acknowledges a task as done by deleting it. Called by a worker once the run
 * has been driven to its next resting point (or the task is a no-op — its run
 * is already terminal). An un-acked task whose lease expires is redelivered.
 */
export const ackRunTask = async (args: { id: number }): Promise<void> => {
  log('ackRunTask: id=%d', args.id);
  await db.OrchestrationRunTask.destroy({ where: { id: args.id } });
};

/**
 * Releases a claimed task so it can be re-claimed later — clears the claim and
 * sets `availableAt` (a backoff delay). The delivery `attempts` counter, already
 * incremented at claim time, is left as-is.
 */
export const retryRunTask = async (args: {
  id: number;
  availableAt: Date;
}): Promise<void> => {
  log('retryRunTask: id=%d availableAt=%s', args.id, args.availableAt);
  await db.OrchestrationRunTask.update(
    { claimedAt: null, leaseExpiresAt: null, availableAt: args.availableAt },
    { where: { id: args.id } }
  );
};
