import {
  ackRunTask,
  claimRunTasks,
  enqueueRunTask,
  retryRunTask,
  type RunTaskInstance,
} from '../orchestrationQueue';
import { getPostgresQueueStats } from '../orchestrationQueueStats';
import type {
  ClaimedTask,
  OrchestrationQueueDriver,
  RunTaskKind,
} from './types';

/**
 * Maps a claimed `orchestration_run_tasks` row onto the driver-neutral shape.
 * The public id is the human-readable identity; the numeric row id is the
 * opaque handle `ack`/`retry` address the delivery by.
 */
const toClaimedTask = (task: RunTaskInstance): ClaimedTask => {
  return {
    id: task.publicId,
    handle: String(task.id as number),
    orchestrationRunId: task.orchestrationRunId as number,
    kind: task.kind as RunTaskKind,
    attempts: task.attempts as number,
  };
};

/**
 * The default driver: the `orchestration_run_tasks` table claimed with
 * `SELECT … FOR UPDATE SKIP LOCKED`. It requires no infrastructure beyond the
 * database the server already needs, and it is the only driver that can honour
 * a project's `max_concurrent_runs` at claim time — the claim is a SQL join
 * over tasks → runs → projects, so the limit is evaluated in the same
 * transaction that leases the task.
 */
export const postgresQueueDriver: OrchestrationQueueDriver = {
  name: 'postgres',
  enforcesProjectConcurrency: true,

  enqueue: async (args) => {
    await enqueueRunTask(args);
  },

  claim: async (args) => {
    const tasks = await claimRunTasks(args);
    return tasks.map(toClaimedTask);
  },

  ack: async (args) => {
    await ackRunTask({ id: Number(args.task.handle) });
  },

  retry: async (args) => {
    await retryRunTask({
      id: Number(args.task.handle),
      availableAt: args.availableAt,
    });
  },

  stats: async (args) => {
    return getPostgresQueueStats(args);
  },
};
