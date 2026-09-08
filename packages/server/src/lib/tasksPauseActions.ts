import createDebug from 'debug';

import { DomainError } from '../errors';
import type { RequestPrincipal } from './principals';
import { emitTaskEvent } from './taskEvents';
import {
  dispatchOnEnter,
  findTaskInstance,
  mapTask,
  stateByName,
} from './tasks';
import { isTaskPaused, PAUSED_AUTOMATION_STATUS } from './tasksPause';
import { resolveTaskDefinition } from './taskWorkflowDefinition';

const log = createDebug('soat:tasks');

/**
 * The two operator actions behind a workflow instance's pause. Separate from
 * `tasksPause.ts` because they reach `tasks.ts` for `dispatchOnEnter`, which the
 * automation runner is on the other side of — the primitives stay importable
 * from inside that cycle, these stay reachable only from the routes.
 */

/**
 * Pauses a task's automation: no state's `on_enter` dispatches and no retry
 * chain continues until it is resumed (#1237).
 *
 * A dispatch already in flight is deliberately left to finish — it is one
 * generation, tool call or run, the same bound an orchestration pause accepts
 * for the round in flight — and its outcome still routes, entering a state whose
 * own dispatch is then suppressed.
 *
 * Idempotent: pausing an already-paused task answers with it unchanged, so a
 * reconciliation loop that pauses on every tick writes once.
 */
export const pauseTask = async (args: {
  id: string;
  reason?: string | null;
}): Promise<ReturnType<typeof mapTask>> => {
  log('pauseTask: id=%s', args.id);

  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  if (task.status === 'closed') {
    throw new DomainError(
      'TASK_NOT_PAUSABLE',
      `Task '${args.id}' is closed and has no automation left to pause.`
    );
  }
  if (isTaskPaused(task)) return mapTask(task);

  await task.update({
    pauseRequestedAt: new Date(),
    pauseReason: args.reason ?? null,
  });

  const refreshed = await findTaskInstance({ id: args.id });
  const mapped = mapTask(refreshed!);
  await emitTaskEvent({
    type: 'tasks.paused',
    projectId: task.projectId as number,
    task: mapped,
  });
  return mapped;
};

/**
 * Lifts a task's pause and dispatches the state's `on_enter` when the pause
 * suppressed it — `automation_status: 'paused'` is the record that it never ran.
 * A state whose dispatch had already completed (or that declares none) is left
 * alone, so a resume never re-spends work the pause did not stop.
 *
 * The dispatch runs as whoever resumed, not as whoever last moved the task: the
 * resume is the decision to spend, and the move that scheduled the work may be
 * weeks old. Mirrors `resolveDispatchPrincipal`'s rule that a human or API-key
 * move names itself.
 */
export const resumeTask = async (args: {
  id: string;
  principal?: RequestPrincipal;
}): Promise<ReturnType<typeof mapTask>> => {
  log('resumeTask: id=%s', args.id);

  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  if (!isTaskPaused(task)) {
    throw new DomainError(
      'TASK_NOT_PAUSED',
      `Task '${args.id}' is not paused.`
    );
  }

  const suppressed = task.automationStatus === PAUSED_AUTOMATION_STATUS;
  await task.update({
    pauseRequestedAt: null,
    pauseReason: null,
    ...(suppressed ? { automationStatus: null } : {}),
  });

  const refreshed = await findTaskInstance({ id: args.id });
  const mapped = mapTask(refreshed!);
  await emitTaskEvent({
    type: 'tasks.resumed',
    projectId: task.projectId as number,
    task: mapped,
  });

  if (suppressed) {
    const { states } = await resolveTaskDefinition({
      task: refreshed!,
      workflow: refreshed!.workflow!,
    });
    const state = stateByName({ states, name: refreshed!.state });
    if (state) {
      dispatchOnEnter({
        taskPublicId: args.id,
        projectId: task.projectId as number,
        state,
        principal: args.principal,
      });
    }
  }

  return mapped;
};
