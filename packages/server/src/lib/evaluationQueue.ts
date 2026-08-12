/**
 * The eval item queue (docs/prd-evaluations.md, Phase 2).
 *
 * An async run enqueues one `EvalRunTask` per dataset item; the eval worker
 * claims them in batches with `SELECT … FOR UPDATE SKIP LOCKED`, executes each
 * item, and acks by deleting the row. Same claim/lease/redelivery mechanics the
 * orchestration queue uses, over this module's own table — see the note on
 * `EvalRunTask` for why the two do not share one.
 *
 * At-least-once delivery is safe here without any extra bookkeeping: writing an
 * item's result is idempotent on the unique `(eval_run_id, dataset_item_id)`
 * index, so a redelivered task re-runs the item into the same row rather than
 * double-counting it.
 */
import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:evaluations');

const EVAL_RUN_TASK_TABLE = 'eval_run_tasks';

const DEFAULT_LEASE_TTL_MS = 300_000;

/**
 * How long a claimed item task is held before it is redelivered. Generous by
 * default (5 min): an item is a real agent generation, which can legitimately
 * take minutes, and a lease shorter than the work it protects turns every slow
 * item into a duplicate execution.
 */
export const evalTaskLeaseTtlMs = (): number => {
  const configured = Number(process.env.EVAL_TASK_LEASE_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LEASE_TTL_MS;
};

export type EvalRunTaskInstance = InstanceType<typeof db.EvalRunTask>;

/**
 * Enqueues one task per item for a run. Idempotent on the unique
 * `(eval_run_id, dataset_item_id)` index — `ignoreDuplicates` makes a retried
 * enqueue a no-op instead of a constraint error, so a run cannot fan one item
 * out to two workers.
 */
export const enqueueEvalItemTasks = async (args: {
  evalRunId: number;
  datasetItemIds: number[];
}): Promise<void> => {
  log(
    'enqueueEvalItemTasks: evalRunId=%d items=%d',
    args.evalRunId,
    args.datasetItemIds.length
  );

  await db.EvalRunTask.bulkCreate(
    args.datasetItemIds.map((datasetItemId) => {
      return {
        // Explicit: `bulkCreate` does not run the model's per-instance
        // `beforeValidate` hook, so the generated public id has to be supplied
        // here — the same reason `persistTokenEvent` passes one for its
        // components.
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.evalRunTask),
        evalRunId: args.evalRunId,
        datasetItemId,
        availableAt: new Date(),
        attempts: 0,
      };
    }),
    { ignoreDuplicates: true }
  );
};

type CandidateRow = { id: number };

/**
 * Claims up to `limit` due tasks in one transaction: locks the due set with
 * `FOR UPDATE SKIP LOCKED` (so concurrent workers partition it rather than
 * contend), then marks the locked rows claimed with a fresh lease and an
 * incremented attempt count.
 *
 * A task is due when `available_at <= now` and it is either unclaimed or its
 * previous lease has expired — the latter being the redelivery path. Raw SQL
 * names the physical snake_case columns; the models are `underscored`.
 */
export const claimEvalItemTasks = async (args: {
  limit: number;
  now?: Date;
}): Promise<EvalRunTaskInstance[]> => {
  const now = args.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + evalTaskLeaseTtlMs());
  const sequelize = db.sequelize;

  const claimedIds = await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `SELECT t."id"
         FROM "${EVAL_RUN_TASK_TABLE}" t
        WHERE t."available_at" <= :now
          AND (t."claimed_at" IS NULL OR t."lease_expires_at" < :now)
        ORDER BY t."available_at" ASC
        LIMIT :limit
        FOR UPDATE OF t SKIP LOCKED`,
      { replacements: { now, limit: args.limit }, transaction }
    );

    const ids = (rows as CandidateRow[]).map((row) => {
      return row.id;
    });
    if (ids.length === 0) return [];

    await db.EvalRunTask.update(
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

  const tasks = await db.EvalRunTask.findAll({
    where: { id: { [Op.in]: claimedIds } },
  });
  log('claimEvalItemTasks: claimed %d task(s)', tasks.length);
  return tasks;
};

/**
 * Acknowledges a task as done by deleting it. An un-acked task whose lease
 * expires is redelivered.
 */
export const ackEvalItemTask = async (args: { id: number }): Promise<void> => {
  log('ackEvalItemTask: id=%d', args.id);
  await db.EvalRunTask.destroy({ where: { id: args.id } });
};

/** How many tasks a run still has outstanding — 0 means it is ready to finalize. */
export const countPendingEvalItemTasks = async (args: {
  evalRunId: number;
}): Promise<number> => {
  return db.EvalRunTask.count({ where: { evalRunId: args.evalRunId } });
};

/**
 * Drops every outstanding task for a run. Used by cancel: a canceled run must
 * stop consuming provider budget on the next tick, and its already-written
 * results stay exactly as they are.
 */
export const discardEvalItemTasks = async (args: {
  evalRunId: number;
}): Promise<number> => {
  const removed = await db.EvalRunTask.destroy({
    where: { evalRunId: args.evalRunId },
  });
  log('discardEvalItemTasks: evalRunId=%d removed=%d', args.evalRunId, removed);
  return removed;
};
