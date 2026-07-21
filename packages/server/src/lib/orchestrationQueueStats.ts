import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { claimLatencySnapshot } from './orchestrationQueue';

const log = createDebug('soat:orchestrations');

// Physical table names (models are `underscored`), used by the per-project
// aggregate that joins tasks → runs → projects.
const RUN_TASK_TABLE = 'orchestration_run_tasks';
const RUN_TABLE = 'orchestration_runs';
const PROJECT_TABLE = 'projects';

export type QueueStats = {
  driver: 'postgres';
  queueDepth: number;
  claimedTasks: number;
  oldestQueuedAgeSeconds: number | null;
  claimLatencyMs: {
    p50: number | null;
    p95: number | null;
    windowSeconds: number;
  };
  perProject: Array<{ projectId: string; queued: number; claimed: number }>;
};

type PerProjectRow = {
  project_id: string;
  queued: string | number;
  claimed: string | number;
};

/**
 * A point-in-time snapshot of the orchestration queue for the queue-stats
 * endpoint. `queueDepth` counts claimable-now unclaimed tasks (backoff-delayed
 * tasks with a future `available_at` are excluded — they are not claimable
 * yet); `claimedTasks` counts tasks holding a valid (unexpired) lease.
 * `oldestQueuedAgeSeconds` is the age of the oldest claimable-now task, or
 * `null` when the queue is empty. `claimLatencyMs` reports p50/p95 over a
 * rolling in-process window. `perProject` lists one row per project with any
 * queued or claimed task, keyed by the project's public id.
 *
 * When `projectIds` is provided, `perProject` is restricted to those projects
 * (a project-scoped caller sees only their own rows); `undefined` includes all.
 */
export const getQueueStats = async (args?: {
  projectIds?: number[];
  now?: Date;
}): Promise<QueueStats> => {
  const now = args?.now ?? new Date();
  log('getQueueStats: projectIds=%o', args?.projectIds);

  const [queueDepth, claimedTasks, oldest] = await Promise.all([
    db.OrchestrationRunTask.count({
      where: { claimedAt: null, availableAt: { [Op.lte]: now } },
    }),
    db.OrchestrationRunTask.count({
      where: {
        claimedAt: { [Op.ne]: null },
        leaseExpiresAt: { [Op.gt]: now },
      },
    }),
    db.OrchestrationRunTask.findOne({
      where: { claimedAt: null, availableAt: { [Op.lte]: now } },
      order: [['availableAt', 'ASC']],
      attributes: ['availableAt'],
    }),
  ]);

  const oldestQueuedAgeSeconds = oldest
    ? Math.max(
        0,
        (now.getTime() - new Date(oldest.availableAt).getTime()) / 1000
      )
    : null;

  const restrictProjects = args?.projectIds !== undefined;
  const [perProjectRows] = await db.sequelize.query(
    `SELECT p."public_id" AS project_id,
            SUM(CASE WHEN t."claimed_at" IS NULL
                      AND t."available_at" <= :now THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN t."claimed_at" IS NOT NULL
                      AND t."lease_expires_at" > :now THEN 1 ELSE 0 END) AS claimed
       FROM "${RUN_TASK_TABLE}" t
       JOIN "${RUN_TABLE}" r ON r."id" = t."run_id"
       JOIN "${PROJECT_TABLE}" p ON p."id" = r."project_id"
      ${restrictProjects ? 'WHERE r."project_id" IN (:projectIds)' : ''}
      GROUP BY p."public_id"
      HAVING SUM(CASE WHEN t."claimed_at" IS NULL
                       AND t."available_at" <= :now THEN 1 ELSE 0 END) > 0
          OR SUM(CASE WHEN t."claimed_at" IS NOT NULL
                       AND t."lease_expires_at" > :now THEN 1 ELSE 0 END) > 0
      ORDER BY p."public_id" ASC`,
    {
      replacements: restrictProjects
        ? { now, projectIds: args?.projectIds }
        : { now },
    }
  );

  const perProject = (perProjectRows as PerProjectRow[]).map((row) => {
    return {
      projectId: row.project_id,
      queued: Number(row.queued),
      claimed: Number(row.claimed),
    };
  });

  return {
    driver: 'postgres',
    queueDepth,
    claimedTasks,
    oldestQueuedAgeSeconds,
    claimLatencyMs: claimLatencySnapshot({ now: now.getTime() }),
    perProject,
  };
};
