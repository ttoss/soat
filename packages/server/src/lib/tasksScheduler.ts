import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { createScheduler, createSweep } from './scheduler';
import {
  emitTaskEvent,
  mapTask,
  stateByName,
  type TaskInstance,
} from './tasks';
import type { WorkflowState } from './workflowsValidation';

const log = createDebug('soat:tasks');

const taskIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Workflow, as: 'workflow' },
  ];
};

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
  // Atomic claim: null the deadline guarded on it still being due and the task
  // still open, so a single stall fires per episode even across overlapping
  // ticks, multiple workers, or a concurrent transition (which would move the
  // task and re-arm its own deadline).
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
    const states = (task.workflow?.states ?? []) as WorkflowState[];
    const stateDef = stateByName({ states, name: task.state });
    await emitTaskEvent({
      type: 'tasks.stalled',
      projectId: task.projectId as number,
      task: mapTask(task),
      extra: {
        state: task.state,
        stalledAfter: stateDef?.stalledAfter ?? null,
      },
    });
    log('sweepStalledTasks: emitted tasks.stalled task=%s', task.publicId);
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'TASKS_SCHEDULER_INTERVAL_MS',
  sweeps: [sweepStalledTasks],
});

/**
 * Starts the task stall sweeper loop. Called once from `server.ts` at startup;
 * unit tests drive {@link sweepStalledTasks} directly instead. The timer is
 * unref'd and repeated calls are a no-op.
 */
export const startTasksScheduler = scheduler.start;

/** Stops the task stall sweeper loop (graceful shutdown / test teardown). */
export const stopTasksScheduler = scheduler.stop;
