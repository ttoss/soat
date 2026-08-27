import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { type SequelizeInstance, type Transaction } from './dbTransaction';
import { taskLeaseTtlMs } from './orchestration-queue-drivers/config';
import type { RunTaskKind } from './orchestration-queue-drivers/types';
import { recordClaimLatency } from './orchestrationQueueMetrics';

// Physical table names — fixed by each model's @Table decorator. The queue
// claim joins tasks → runs → projects to read the per-project concurrency limit.
const RUN_TASK_TABLE = 'orchestration_run_tasks';
const RUN_TABLE = 'orchestration_runs';
const PROJECT_TABLE = 'projects';

// Advisory-lock namespace (first key of the two-int `pg_advisory_xact_lock`)
// used to serialize per-project concurrency claim decisions across workers.
// Distinct from the schema-sync lock key so the two never collide.
const PROJECT_CONCURRENCY_LOCK_NAMESPACE = 0x50a7_c000;

const log = createDebug('soat:orchestrations');

export type RunTaskInstance = InstanceType<typeof db.OrchestrationRunTask>;

/**
 * Enqueues a task for a run. `availableAt` in the future parks the task until
 * then (used for backoff / scheduled availability); omitted, it is claimable
 * immediately. Returns the created task row.
 */
export const enqueueRunTask = async (args: {
  orchestrationRunId: number;
  kind: RunTaskKind;
  availableAt?: Date;
}): Promise<RunTaskInstance> => {
  log(
    'enqueueRunTask: orchestrationRunId=%d kind=%s',
    args.orchestrationRunId,
    args.kind
  );
  return db.OrchestrationRunTask.create({
    orchestrationRunId: args.orchestrationRunId,
    kind: args.kind,
    availableAt: args.availableAt ?? new Date(),
    attempts: 0,
  });
};

type CandidateRow = {
  id: number;
  orchestration_run_id: number;
  project_id: number;
  available_at: Date;
  max_concurrent_runs: number | null;
};

/**
 * Greedily selects which candidate tasks may be claimed under the per-project
 * concurrency limit (`max_concurrent_runs`, D8/D9). A project with a `null`
 * limit is unlimited. `occupancy` maps a project to the number of *other* runs
 * already holding a claimed, lease-valid task (slots in use before this batch).
 * Candidates are walked in `available_at` order (oldest first); a run is
 * granted a slot only while `occupancy + slots-granted-this-batch < limit`.
 *
 * Self-exclusion (D9): a run never counts against itself — occupancy counts
 * other runs, and a run already granted this batch is claimed again for free
 * (multiple tasks of one run share its single slot). This is what keeps a
 * multi-round run's own `continue` tasks from deadlocking under a limit of 1.
 */
const selectClaimableUnderLimit = (args: {
  candidates: CandidateRow[];
  occupancy: Map<number, number>;
}): number[] => {
  const grantedRunsByProject = new Map<number, Set<number>>();
  const chosen: number[] = [];

  for (const row of args.candidates) {
    const limit = row.max_concurrent_runs;
    if (limit == null) {
      chosen.push(row.id);
      continue;
    }
    let granted = grantedRunsByProject.get(row.project_id);
    if (!granted) {
      granted = new Set<number>();
      grantedRunsByProject.set(row.project_id, granted);
    }
    // A run already granted a slot in this batch takes no additional slot.
    if (granted.has(row.orchestration_run_id)) {
      chosen.push(row.id);
      continue;
    }
    const inUse = (args.occupancy.get(row.project_id) ?? 0) + granted.size;
    if (inUse < limit) {
      granted.add(row.orchestration_run_id);
      chosen.push(row.id);
    }
    // else: no free slot — leave the task queued (its row lock releases when the
    // transaction ends without an UPDATE, so it stays claimable next tick).
  }

  return chosen;
};

/**
 * Locks and returns the due candidate tasks joined to their run + project (to
 * read each project's concurrency limit). `FOR UPDATE OF t SKIP LOCKED` locks
 * only the task rows, so concurrent claimers partition the due set instead of
 * contending. A task is due when `available_at <= now` and it is either
 * unclaimed or its previous lease has expired (redelivery). Raw SQL references
 * the physical (snake_case) columns — the models use `underscored`.
 */
const selectDueCandidates = async (args: {
  sequelize: SequelizeInstance;
  transaction: Transaction;
  now: Date;
  limit: number;
}): Promise<CandidateRow[]> => {
  const [rows] = await args.sequelize.query(
    `SELECT t."id", t."orchestration_run_id", t."available_at",
            r."project_id", p."max_concurrent_runs"
       FROM "${RUN_TASK_TABLE}" t
       JOIN "${RUN_TABLE}" r ON r."id" = t."orchestration_run_id"
       JOIN "${PROJECT_TABLE}" p ON p."id" = r."project_id"
      WHERE t."available_at" <= :now
        AND (t."claimed_at" IS NULL OR t."lease_expires_at" < :now)
      ORDER BY t."available_at" ASC
      LIMIT :limit
      FOR UPDATE OF t SKIP LOCKED`,
    {
      replacements: { now: args.now, limit: args.limit },
      transaction: args.transaction,
    }
  );
  return rows as CandidateRow[];
};

/**
 * Slots already in use per limited project: distinct runs holding a claimed,
 * lease-valid task. Only projects with a `max_concurrent_runs` are queried;
 * unlimited projects need no occupancy and take no lock (common path stays
 * fully concurrent). For each limited project a transaction-scoped advisory
 * lock (released on commit) is taken first, in ascending id order, so the
 * read-decide-claim step is atomic per project across worker processes — the
 * row-level SKIP LOCKED alone only stops two workers claiming the *same* task,
 * not two different tasks of one over-full project. Candidate rows are locked
 * but not yet updated, so they are not counted here.
 */
const loadProjectOccupancy = async (args: {
  sequelize: SequelizeInstance;
  transaction: Transaction;
  now: Date;
  candidates: CandidateRow[];
}): Promise<Map<number, number>> => {
  const occupancy = new Map<number, number>();
  const limitedProjectIds = [
    ...new Set(
      args.candidates
        .filter((c) => {
          return c.max_concurrent_runs != null;
        })
        .map((c) => {
          return c.project_id;
        })
    ),
  ].sort((a, b) => {
    return a - b;
  });
  if (limitedProjectIds.length === 0) return occupancy;

  for (const pid of limitedProjectIds) {
    await args.sequelize.query('SELECT pg_advisory_xact_lock(:ns, :pid)', {
      replacements: { ns: PROJECT_CONCURRENCY_LOCK_NAMESPACE, pid },
      transaction: args.transaction,
    });
  }

  const [occRows] = await args.sequelize.query(
    `SELECT r."project_id" AS project_id,
            COUNT(DISTINCT t."orchestration_run_id") AS cnt
       FROM "${RUN_TASK_TABLE}" t
       JOIN "${RUN_TABLE}" r ON r."id" = t."orchestration_run_id"
      WHERE t."claimed_at" IS NOT NULL
        AND t."lease_expires_at" > :now
        AND r."project_id" IN (:projectIds)
      GROUP BY r."project_id"`,
    {
      replacements: { now: args.now, projectIds: limitedProjectIds },
      transaction: args.transaction,
    }
  );
  for (const row of occRows as Array<{
    project_id: number;
    cnt: string | number;
  }>) {
    occupancy.set(row.project_id, Number(row.cnt));
  }
  return occupancy;
};

const recordClaimLatencies = (args: {
  candidates: CandidateRow[];
  chosenIds: number[];
  now: Date;
}): void => {
  const chosen = new Set(args.chosenIds);
  for (const c of args.candidates) {
    if (!chosen.has(c.id)) continue;
    const latencyMs = Math.max(
      0,
      args.now.getTime() - new Date(c.available_at).getTime()
    );
    recordClaimLatency({ at: args.now.getTime(), latencyMs });
  }
};

/**
 * Claims up to `limit` due tasks with `SELECT … FOR UPDATE SKIP LOCKED`, then
 * marks the claimable subset claimed (setting the lease, incrementing
 * `attempts`) in one transaction, so two workers racing a tick never claim the
 * same task. A task is due when `available_at <= now` and it is either
 * unclaimed or its lease has expired.
 *
 * The claimable subset also honors each run's project `max_concurrent_runs`
 * (D8/D9): a task whose project already has that many runs actively driven
 * stays queued. Only actively-driven runs occupy a slot — parked runs hold no
 * task — and a run never blocks on itself.
 */
export const claimRunTasks = async (args: {
  limit: number;
  now?: Date;
}): Promise<RunTaskInstance[]> => {
  const now = args.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + taskLeaseTtlMs());
  const sequelize = db.sequelize;

  const claimed = await sequelize.transaction(async (transaction) => {
    const candidates = await selectDueCandidates({
      sequelize,
      transaction,
      now,
      limit: args.limit,
    });
    if (candidates.length === 0) return [];

    const occupancy = await loadProjectOccupancy({
      sequelize,
      transaction,
      now,
      candidates,
    });

    const ids = selectClaimableUnderLimit({ candidates, occupancy });
    if (ids.length === 0) return [];

    await db.OrchestrationRunTask.update(
      {
        claimedAt: now,
        leaseExpiresAt,
        attempts: sequelize.literal('"attempts" + 1'),
      },
      { where: { id: { [Op.in]: ids } }, transaction }
    );

    recordClaimLatencies({ candidates, chosenIds: ids, now });
    return ids;
  });

  if (claimed.length === 0) return [];

  const tasks = await db.OrchestrationRunTask.findAll({
    where: { id: { [Op.in]: claimed } },
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
