import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { createScheduler, createSweep } from './scheduler';
import { emitTaskEvent } from './taskEvents';
import { mapTask, taskIncludes, type TaskInstance } from './tasks';
import type { TaskWithWorkflow } from './tasksAutomationLocking';
import {
  claimOrphanedDispatch,
  findStaleDispatches,
  routeOrphanedDispatch,
} from './tasksReconciliation';

const log = createDebug('soat:tasks');

/**
 * Finds open tasks whose stall deadline is due (`status = 'open'` and
 * `stallDeadlineAt <= now`), atomically claims each one (nulling the deadline so
 * the episode is spent), and emits `tasks.stalled`. `stallDeadlineAt` is the
 * precomputed `entered_state_at + stalled_after` for the current state, so the
 * due-set query is a single indexed range scan rather than a scan of every open
 * task. The stall is an **event, not a transition** — routing on it stays the
 * author's choice via webhook/trigger composition (PRD §6.6). The next
 * transition re-arms the deadline for the state the task enters.
 *
 * Returns the number of tasks claimed for a stall emission this tick.
 */
export const sweepStalledTasks = createSweep<TaskInstance>({
  log,
  name: 'sweepStalledTasks',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.Task.findAll({
      where: { status: 'open', stallDeadlineAt: { [Op.lte]: now } },
      order: [['stallDeadlineAt', 'ASC']],
      include: taskIncludes(),
      limit,
    }) as Promise<TaskInstance[]>;
  },
  idOf: (task) => {
    return task.id as number;
  },
  // Atomic claim, guarded on the deadline still being due and the task still
  // open, so one stall fires per episode across overlapping ticks, multiple
  // workers, or a concurrent transition.
  claim: async ({ row: task, now }) => {
    const [claimed] = await db.Task.update(
      { stallDeadlineAt: null },
      {
        where: {
          id: task.id as number,
          status: 'open',
          stallDeadlineAt: { [Op.lte]: now },
        },
      }
    );
    return claimed > 0;
  },
  handle: async ({ row: task }) => {
    // The event carries the stalled state and the full task; a consumer that
    // needs the threshold reads `stalled_after` from the workflow definition.
    await emitTaskEvent({
      type: 'tasks.stalled',
      projectId: task.projectId as number,
      task: mapTask(task),
      extra: { state: task.state },
    });
    log('sweepStalledTasks: emitted tasks.stalled task=%s', task.publicId);
  },
});

/**
 * Recovers tasks whose dispatch outcome nobody was left to hear.
 *
 * A dispatch is awaited in-process while the run it waits on is durable and
 * scheduler-owned (#855). A restart while the run is `sleeping` loses the
 * awaiter but not the run: the run finishes, and without this sweep nothing
 * routes `on_complete`, stranding the task at `automation_status: 'running'`.
 *
 * Claiming uses the same atomic guarded write as `commitCompletion`, so a live
 * awaiter racing the sweep loses cleanly instead of routing twice. Returns the
 * number of outcomes claimed this tick.
 */
export const reconcileOrphanedDispatches = createSweep<TaskWithWorkflow>({
  log,
  name: 'reconcileOrphanedDispatches',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return findStaleDispatches({ now, limit });
  },
  idOf: (task) => {
    return task.id as number;
  },
  claim: ({ row: task }) => {
    return claimOrphanedDispatch({ task });
  },
  handle: async ({ row: task }) => {
    await routeOrphanedDispatch({ taskPublicId: task.publicId as string });
    log('reconcileOrphanedDispatches: routed recovered task=%s', task.publicId);
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'TASKS_SCHEDULER_INTERVAL_MS',
  sweeps: [sweepStalledTasks, reconcileOrphanedDispatches],
});

/**
 * Starts the task sweeper loop — stall deadlines and orphaned dispatches.
 * Called once from `server.ts` at startup; unit tests drive
 * {@link sweepStalledTasks} and {@link reconcileOrphanedDispatches} directly
 * instead. The timer is unref'd and repeated calls are a no-op.
 */
export const startTasksScheduler = scheduler.start;

/** Stops the task sweeper loop (graceful shutdown / test teardown). */
export const stopTasksScheduler = scheduler.stop;
