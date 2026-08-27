import createDebug from 'debug';

import { DomainError } from '../errors';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import type { RequestPrincipal } from './principals';
import { emitTaskEvent } from './taskEvents';
import type { ActiveDispatch } from './tasks';
import { mapTask, transitionTask } from './tasks';
import {
  applyLocked,
  loadTask,
  stillInState,
  type TaskWithWorkflow,
} from './tasksAutomationLocking';
import { runDispatchWithRetry } from './tasksAutomationRetry';
import { type DispatchResult, failedDispatchIds } from './tasksDispatch';
import type { OnEnter, WorkflowDispatch } from './workflowsValidation';

const log = createDebug('soat:tasks');

const buildTaskContext = (task: TaskWithWorkflow) => {
  return {
    task: {
      id: task.publicId,
      title: task.title,
      state: task.state,
      status: task.status,
      payload: task.payload,
      assignee: task.assignee,
      // Server-owned, in its own namespace: a guard on `task.last_result`
      // can only be satisfied by a value an automation wrote (#846).
      last_result: task.lastResult ?? null,
    },
  };
};

const setDispatchState = async (args: {
  task: TaskWithWorkflow;
  activeDispatch: ActiveDispatch | null;
  automationStatus: string | null;
  lastResult?: unknown;
}): Promise<void> => {
  args.task.activeDispatch = args.activeDispatch;
  args.task.automationStatus = args.automationStatus;
  if (args.lastResult !== undefined) {
    // Typed column, never the payload bag — the payload is caller-owned and a
    // caller-writable `last_result` key must not feed transition guards (#846).
    args.task.lastResult = args.lastResult;
  }
  await args.task.save();
};

// The matched rule could not be applied — guard-rejected, or invalidated by a
// concurrent move. Surfaced rather than swallowed, so the task is never left
// silently parked as `completed`.
const REJECTION_CODES: ReadonlySet<string> = new Set([
  'TASK_GUARD_REJECTED',
  'TASK_TRANSITION_CONFLICT',
  // Routed here to make the bound visible: otherwise it reaches the
  // fire-and-forget `.catch` in `dispatchOnEnter` and the cycle stops silently,
  // barely better than looping (#885).
  'TASK_AUTOMATION_CHAIN_LIMIT',
]);

/**
 * Surfaces a dispatch whose outcome did not route: either no `on_complete` rule
 * matched, or the matched rule's transition was rejected. Emits an event so the
 * task is never silently stuck. For a rejected transition it also flags the task
 * `automation_status: 'unrouted'` (atomically, only while our completion is
 * still current, so a concurrent transition's state is never clobbered) so
 * board queries can find it.
 */
const surfaceUnrouted = async (args: {
  taskPublicId: string;
  projectId: number;
  result: unknown;
  rejected?: { transition: string; code: string };
}): Promise<void> => {
  let task: TaskWithWorkflow | null = null;
  if (args.rejected) {
    task = await applyLocked({
      taskPublicId: args.taskPublicId,
      guard: (t) => {
        return t.automationStatus === 'completed';
      },
      mutate: (t) => {
        t.automationStatus = 'unrouted';
      },
    });
  }
  if (!task) {
    task = await loadTask(args.taskPublicId);
  }
  if (!task) return;

  await emitTaskEvent({
    type: args.rejected
      ? 'tasks.automation_rejected'
      : 'tasks.automation_unrouted',
    projectId: args.projectId,
    task: mapTask(task),
    extra: {
      result: args.result,
      ...(args.rejected
        ? {
            transition: args.rejected.transition,
            errorCode: args.rejected.code,
          }
        : {}),
    },
  });
};

const routeOnComplete = async (args: {
  taskPublicId: string;
  onEnter: OnEnter;
  context: Record<string, unknown>;
  result: unknown;
  projectId: number;
  generationId: string | null;
  orchestrationRunId: string | null;
  toolId: string | null;
}): Promise<void> => {
  const rules = args.onEnter.onComplete ?? [];
  const matched = rules.find((rule) => {
    return Boolean(
      evaluateLogic(rule.when, { ...args.context, result: args.result })
    );
  });

  if (matched) {
    log(
      'routeOnComplete: task=%s -> transition=%s',
      args.taskPublicId,
      matched.transition
    );
    try {
      await transitionTask({
        id: args.taskPublicId,
        transition: matched.transition,
        // No principal moved the task: `generationId` / `orchestrationRunId`
        // below carry the cause, so the id is not duplicated here (#786).
        principal: { kind: 'automation', id: null },
        generationId: args.generationId,
        orchestrationRunId: args.orchestrationRunId,
        toolId: args.toolId,
      });
    } catch (error) {
      // Otherwise this reaches the fire-and-forget `.catch` in
      // `dispatchOnEnter` and leaves the task looking `completed` with no signal.
      if (error instanceof DomainError && REJECTION_CODES.has(error.code)) {
        log(
          'routeOnComplete: transition=%s rejected (%s) task=%s',
          matched.transition,
          error.code,
          args.taskPublicId
        );
        await surfaceUnrouted({
          taskPublicId: args.taskPublicId,
          projectId: args.projectId,
          result: args.result,
          rejected: { transition: matched.transition, code: error.code },
        });
        return;
      }
      throw error;
    }
    return;
  }

  // No rule matched — the task stays put, automation_status stays 'completed',
  // and we surface the fact rather than leaving it silently stuck.
  await surfaceUnrouted({
    taskPublicId: args.taskPublicId,
    projectId: args.projectId,
    result: args.result,
  });
};

/**
 * Routes an already-committed dispatch outcome through `on_complete` /
 * `on_failure`. The in-process path reaches this through `runStateAutomation`
 * below; the reconciler (`tasksReconciliation`) calls it for a task whose
 * awaiter died with its process, so a recovered outcome routes through exactly
 * the same rules — including `surfaceUnrouted` when nothing matches — rather
 * than a parallel implementation that could disagree about which rule wins.
 */
export const routeSettledDispatch = async (args: {
  task: TaskWithWorkflow;
  onEnter: OnEnter;
  succeeded: boolean;
  result: unknown;
  orchestrationRunId: string | null;
}): Promise<void> => {
  const taskPublicId = args.task.publicId as string;
  const projectId = args.task.projectId as number;

  if (!args.succeeded) {
    if (!args.onEnter.onFailure) return;
    await transitionTask({
      id: taskPublicId,
      transition: args.onEnter.onFailure,
      principal: { kind: 'automation', id: null },
      generationId: null,
      orchestrationRunId: args.orchestrationRunId,
    });
    return;
  }

  await routeOnComplete({
    taskPublicId,
    onEnter: args.onEnter,
    context: buildTaskContext(args.task),
    result: args.result,
    projectId,
    generationId: null,
    orchestrationRunId: args.orchestrationRunId,
    // The reconciler only ever recovers orchestration dispatches, so a tool is
    // never the cause here (`tasksReconciliation.settledRun`).
    toolId: null,
  });
};

const handleFailure = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
  onEnter: OnEnter;
  projectId: number;
  dispatchKind: ActiveDispatch['kind'];
  attempt: number | undefined;
  error: unknown;
  /** Set for a `tool` dispatch: the cause `on_failure` records (#792). */
  toolId: string | null;
}): Promise<void> => {
  log(
    'runStateAutomation: dispatch failed task=%s %o',
    args.taskPublicId,
    args.error
  );
  const { generationId, orchestrationRunId } = failedDispatchIds(args.error);
  const failedId = generationId ?? orchestrationRunId;
  const task = await applyLocked({
    taskPublicId: args.taskPublicId,
    guard: stillInState({ stateName: args.stateName, token: args.token }),
    mutate: (t) => {
      t.activeDispatch = {
        kind: args.dispatchKind,
        id: failedId,
        status: 'failed',
        ...(args.attempt === undefined ? {} : { attempt: args.attempt }),
      };
      t.automationStatus = 'failed';
    },
  });
  if (!task) return;

  if (args.onEnter.onFailure) {
    await transitionTask({
      id: args.taskPublicId,
      transition: args.onEnter.onFailure,
      principal: { kind: 'automation', id: null },
      generationId,
      orchestrationRunId,
      toolId: args.toolId,
    });
  }
};

// Discarded rather than clobbering the new state if the task moved or
// re-entered since the dispatch started (#590).
const commitCompletion = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
  dispatchKind: ActiveDispatch['kind'];
  attempt: number | undefined;
  dispatched: DispatchResult;
  context: Record<string, unknown>;
  payloadWrites: Record<string, unknown> | undefined;
}): Promise<TaskWithWorkflow | null> => {
  return applyLocked({
    taskPublicId: args.taskPublicId,
    guard: stillInState({ stateName: args.stateName, token: args.token }),
    mutate: (t) => {
      t.activeDispatch = {
        kind: args.dispatchKind,
        id: args.dispatched.generationId ?? args.dispatched.orchestrationRunId,
        status: 'completed',
        ...(args.attempt === undefined ? {} : { attempt: args.attempt }),
      };
      t.automationStatus = 'completed';
      // `payload_writes` is evaluated over the same `{task, result}` context
      // `on_complete` rules see, and applied after `last_result` so a
      // deterministic write is never clobbered by the generic result echo.
      const writes = applyInputMapping(args.payloadWrites, {
        ...args.context,
        result: args.dispatched.result,
      });
      if (Object.keys(writes).length > 0) {
        log(
          'commitCompletion: task=%s payload_writes=%o',
          args.taskPublicId,
          writes
        );
      }
      t.lastResult = args.dispatched.result;
      if (Object.keys(writes).length > 0) {
        t.payload = {
          ...(t.payload as Record<string, unknown>),
          ...writes,
        };
      }
    },
  });
};

/**
 * Executes a state's `on_enter` automation for a task: resolves the dispatch
 * input from the task payload, runs the single agent generation, orchestration
 * run or tool call, records provenance and `automation_status`, and routes the
 * outcome through `on_complete` / `on_failure`. Detached (fire-and-forget) —
 * callers `void` it. At most one dispatch is active per task; if the task has
 * already left the state by the time the dispatch resolves, the result is
 * discarded (cancellation-on-exit).
 */
const dispatchKindOf = (kind: string): ActiveDispatch['kind'] => {
  if (kind === 'agent') return 'generation';
  if (kind === 'tool') return 'tool_call';
  return 'orchestration_run';
};

/**
 * A failed dispatch's provenance for the `tool` kind. The success path reads it
 * off the `DispatchResult`, but a failure has no result to read — and an
 * automation move still needs a recorded cause (#792), so it comes from the
 * definition instead.
 */
const failedToolId = (dispatch: WorkflowDispatch): string | null => {
  if (dispatch.kind !== 'tool') return null;
  return dispatch.toolId ?? null;
};

/** Marks the dispatch in flight before it starts, with no id known yet. */
const markDispatchRunning = (args: {
  task: TaskWithWorkflow;
  dispatchKind: ActiveDispatch['kind'];
  retry: OnEnter['retry'];
}): Promise<void> => {
  return setDispatchState({
    task: args.task,
    activeDispatch: {
      kind: args.dispatchKind,
      id: null,
      status: 'running',
      ...(args.retry ? { attempt: 1 } : {}),
    },
    automationStatus: 'running',
  });
};

export const runStateAutomation = async (args: {
  taskPublicId: string;
  projectId: number;
  stateName: string;
  onEnter: OnEnter;
  principal?: RequestPrincipal;
}): Promise<void> => {
  const dispatch = args.onEnter.dispatch;
  const dispatchKind = dispatchKindOf(dispatch.kind);

  const task = await loadTask(args.taskPublicId);
  if (!task || task.state !== args.stateName) return;
  const token = (task.enteredStateAt as Date).getTime();

  const context = buildTaskContext(task);
  const inputs = applyInputMapping(dispatch.inputMapping, context);

  // No `retry` declared means one attempt and no `attempt` counter on
  // `active_dispatch` — exactly today's behavior (#822).
  const retry = args.onEnter.retry ?? null;

  await markDispatchRunning({ task, dispatchKind, retry });

  const outcome = await runDispatchWithRetry({
    taskPublicId: args.taskPublicId,
    stateName: args.stateName,
    token,
    projectId: args.projectId,
    dispatch,
    dispatchKind,
    inputs,
    taskContext: context,
    retry,
    principal: args.principal,
    toolContext: task.toolContext ?? undefined,
  });

  if (outcome.kind === 'abandoned') return;
  if (outcome.kind === 'failed') {
    // Only the last attempt reaches here, so `on_failure` (or the parked
    // `automation_status: 'failed'`) fires once per dispatch, never per attempt.
    await handleFailure({
      taskPublicId: args.taskPublicId,
      stateName: args.stateName,
      token,
      onEnter: args.onEnter,
      projectId: args.projectId,
      dispatchKind,
      attempt: outcome.attempt,
      error: outcome.error,
      toolId: failedToolId(dispatch),
    });
    return;
  }
  const dispatched: DispatchResult = outcome.dispatched;

  // Cancellation-on-exit: commit the completion only if the task hasn't moved
  // or re-entered since the dispatch started (#590).
  const current = await commitCompletion({
    taskPublicId: args.taskPublicId,
    stateName: args.stateName,
    token,
    dispatchKind,
    attempt: outcome.attempt,
    dispatched,
    context,
    payloadWrites: dispatch.payloadWrites,
  });
  if (!current) {
    log(
      'runStateAutomation: discarding stale result task=%s',
      args.taskPublicId
    );
    return;
  }

  await routeOnComplete({
    taskPublicId: args.taskPublicId,
    onEnter: args.onEnter,
    context,
    result: dispatched.result,
    projectId: args.projectId,
    generationId: dispatched.generationId,
    orchestrationRunId: dispatched.orchestrationRunId,
    toolId: dispatched.toolId,
  });
};
