import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { GenerationResult } from './agentGenerationHelpers';
import { createGeneration } from './agents';
import type { GenerationInputMessage } from './generationInputMessages';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import { startOrchestrationRun } from './orchestrationEngine';
import type { ActiveDispatch } from './tasks';
import { emitTaskEvent, mapTask, transitionTask } from './tasks';
import type { OnEnter, WorkflowDispatch } from './workflowsValidation';

const log = createDebug('soat:tasks');

type TaskWithWorkflow = InstanceType<(typeof db)['Task']> & {
  project?: InstanceType<(typeof db)['Project']>;
  workflow?: InstanceType<(typeof db)['Workflow']>;
};

const loadTask = async (id: string): Promise<TaskWithWorkflow | null> => {
  return db.Task.findOne({
    where: { publicId: id },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Workflow, as: 'workflow' },
    ],
  }) as Promise<TaskWithWorkflow | null>;
};

const buildTaskContext = (task: TaskWithWorkflow) => {
  return {
    task: {
      id: task.publicId,
      title: task.title,
      state: task.state,
      status: task.status,
      payload: task.payload,
      assignee: task.assignee,
    },
  };
};

/**
 * Shapes a dispatch `input_mapping` result into agent messages: an explicit
 * `messages` array is passed through, a `prompt` string becomes a single user
 * message, and any other non-empty object is JSON-encoded as one user message.
 */
const buildAgentMessages = (
  inputs: Record<string, unknown>
): GenerationInputMessage[] => {
  if (Array.isArray(inputs.messages)) {
    return inputs.messages as GenerationInputMessage[];
  }
  if (typeof inputs.prompt === 'string' && inputs.prompt.length > 0) {
    return [{ role: 'user', content: inputs.prompt }];
  }
  return [{ role: 'user', content: JSON.stringify(inputs) }];
};

/** Whether the task is still parked in the state whose automation we launched. */
const isStale = (args: {
  task: TaskWithWorkflow | null;
  stateName: string;
  token: number;
}): boolean => {
  if (!args.task) return true;
  if (args.task.state !== args.stateName) return true;
  const enteredAt = args.task.enteredStateAt as Date;
  return enteredAt.getTime() !== args.token;
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
    args.task.payload = {
      ...(args.task.payload as Record<string, unknown>),
      last_result: args.lastResult,
    };
  }
  await args.task.save();
};

// Runs one dispatch and returns its exposed `{result}` and provenance ids. A
// generation exposes its output; an orchestration run exposes its final state
// (matching sub-orchestration semantics, PRD D2).
const runDispatch = async (args: {
  dispatch: WorkflowDispatch;
  projectId: number;
  inputs: Record<string, unknown>;
}): Promise<{
  result: unknown;
  generationId: string | null;
  runId: string | null;
}> => {
  if (args.dispatch.kind === 'agent') {
    const gen = (await createGeneration({
      agentId: args.dispatch.agentId!,
      projectIds: [args.projectId],
      messages: buildAgentMessages(args.inputs),
      stream: false,
    })) as GenerationResult;
    return {
      result: gen.output ?? {},
      generationId: gen.id,
      runId: null,
    };
  }

  const run = await startOrchestrationRun({
    orchestrationPublicId: args.dispatch.orchestrationId!,
    projectIds: [args.projectId],
    input: args.inputs,
    wait: true,
  });
  return {
    result: run.state ?? {},
    generationId: null,
    runId: run.id,
  };
};

// Transition failures that mean the matched rule could not be applied — the
// automation actor was guard-rejected, or a concurrent move invalidated the
// transition. Both must be surfaced, not swallowed, so the task is never left
// silently parked as `completed` (PRD §6.3).
const REJECTION_CODES: ReadonlySet<string> = new Set([
  'TASK_GUARD_REJECTED',
  'TASK_TRANSITION_CONFLICT',
]);

/**
 * Surfaces a dispatch whose outcome did not route: either no `on_complete` rule
 * matched, or the matched rule's transition was rejected. Emits an event so the
 * task is never silently stuck. For a rejected transition it also flags the task
 * `automation_status: 'unrouted'` (only while our completion is still current,
 * so a concurrent transition's state is never clobbered) so board queries can
 * find it.
 */
const surfaceUnrouted = async (args: {
  taskPublicId: string;
  projectId: number;
  result: unknown;
  rejected?: { transition: string; code: string };
}): Promise<void> => {
  const task = await loadTask(args.taskPublicId);
  if (!task) return;

  if (args.rejected && task.automationStatus === 'completed') {
    task.automationStatus = 'unrouted';
    await task.save();
  }

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
  runId: string | null;
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
        actor: {
          kind: 'automation',
          id: args.generationId ?? args.runId ?? null,
        },
        generationId: args.generationId,
        runId: args.runId,
      });
    } catch (error) {
      // A matched rule whose transition is guard-rejected (or invalidated by a
      // concurrent move) would otherwise propagate up to the fire-and-forget
      // `.catch` in dispatchOnEnter and leave the task looking `completed` with
      // no signal. Surface it instead.
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

const handleFailure = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
  onEnter: OnEnter;
  projectId: number;
  dispatchKind: ActiveDispatch['kind'];
  error: unknown;
}): Promise<void> => {
  log(
    'runStateAutomation: dispatch failed task=%s %o',
    args.taskPublicId,
    args.error
  );
  const task = await loadTask(args.taskPublicId);
  if (isStale({ task, stateName: args.stateName, token: args.token })) return;

  await setDispatchState({
    task: task!,
    activeDispatch: { kind: args.dispatchKind, id: null, status: 'failed' },
    automationStatus: 'failed',
  });

  if (args.onEnter.onFailure) {
    await transitionTask({
      id: args.taskPublicId,
      transition: args.onEnter.onFailure,
      actor: { kind: 'automation', id: null },
    });
  }
};

/**
 * Executes a state's `on_enter` automation for a task: resolves the dispatch
 * input from the task payload, runs the single agent generation or
 * orchestration run, records provenance and `automation_status`, and routes the
 * outcome through `on_complete` / `on_failure`. Detached (fire-and-forget) —
 * callers `void` it. At most one dispatch is active per task; if the task has
 * already left the state by the time the dispatch resolves, the result is
 * discarded (cancellation-on-exit).
 */
export const runStateAutomation = async (args: {
  taskPublicId: string;
  projectId: number;
  stateName: string;
  onEnter: OnEnter;
}): Promise<void> => {
  const dispatch = args.onEnter.dispatch;
  const dispatchKind: ActiveDispatch['kind'] =
    dispatch.kind === 'agent' ? 'generation' : 'orchestration_run';

  const task = await loadTask(args.taskPublicId);
  if (!task || task.state !== args.stateName) return;
  const token = (task.enteredStateAt as Date).getTime();

  const context = buildTaskContext(task);
  const inputs = applyInputMapping(dispatch.inputMapping, context);

  await setDispatchState({
    task,
    activeDispatch: { kind: dispatchKind, id: null, status: 'running' },
    automationStatus: 'running',
  });

  let dispatched: {
    result: unknown;
    generationId: string | null;
    runId: string | null;
  };
  try {
    dispatched = await runDispatch({
      dispatch,
      projectId: args.projectId,
      inputs,
    });
  } catch (error) {
    await handleFailure({
      taskPublicId: args.taskPublicId,
      stateName: args.stateName,
      token,
      onEnter: args.onEnter,
      projectId: args.projectId,
      dispatchKind,
      error,
    });
    return;
  }

  // Cancellation-on-exit: the task moved (or re-entered) while the dispatch ran,
  // so its result no longer applies.
  const current = await loadTask(args.taskPublicId);
  if (isStale({ task: current, stateName: args.stateName, token })) {
    log(
      'runStateAutomation: discarding stale result task=%s',
      args.taskPublicId
    );
    return;
  }

  await setDispatchState({
    task: current!,
    activeDispatch: {
      kind: dispatchKind,
      id: dispatched.generationId ?? dispatched.runId,
      status: 'completed',
    },
    automationStatus: 'completed',
    lastResult: dispatched.result,
  });

  await routeOnComplete({
    taskPublicId: args.taskPublicId,
    onEnter: args.onEnter,
    context,
    result: dispatched.result,
    projectId: args.projectId,
    generationId: dispatched.generationId,
    runId: dispatched.runId,
  });
};
