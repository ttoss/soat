import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { evaluateLogic } from './jsonLogicMapping';
import {
  type ActiveDispatch,
  dispatchOnEnter,
  emitTaskEvent,
  findTaskInstance,
  mapTask,
  stateByName,
  type TaskActor,
  type TaskInstance,
} from './tasks';
import {
  findValidTransition,
  type WorkflowState,
  type WorkflowTransition,
} from './workflowsValidation';

const log = createDebug('soat:tasks');

const buildTaskContext = (task: TaskInstance) => {
  return {
    id: task.publicId,
    title: task.title,
    state: task.state,
    status: task.status,
    payload: task.payload,
    assignee: task.assignee,
  };
};

/** Best-effort cancellation of a still-running dispatch when a task leaves its state. */
const cancelDispatchOnExit = async (args: {
  previous: ActiveDispatch | null;
  projectId: number;
}): Promise<void> => {
  const prev = args.previous;
  if (!prev || prev.status !== 'running') return;
  if (prev.kind === 'orchestration_run' && prev.id) {
    try {
      const { cancelOrchestrationRun } =
        await import('./orchestrationRunActions');
      await cancelOrchestrationRun({
        runPublicId: prev.id,
        projectIds: [args.projectId],
      });
    } catch (error) {
      // A terminal run is not cancellable — nothing to do.
      log('cancelDispatchOnExit: %o', error);
    }
  }
  // Generation dispatches are detached: their late result is discarded by the
  // staleness check in tasksAutomation (task re-validated on completion).
};

const evaluateGuard = (args: {
  transition: WorkflowTransition;
  task: TaskInstance;
  actor: TaskActor;
}): void => {
  if (args.transition.guard == null) return;
  const ok = Boolean(
    evaluateLogic(args.transition.guard, {
      task: buildTaskContext(args.task),
      transition: { name: args.transition.name },
      actor: args.actor,
    })
  );
  if (!ok) {
    throw new DomainError(
      'TASK_GUARD_REJECTED',
      `The guard for transition '${args.transition.name}' rejected this move.`,
      { transition: args.transition.name }
    );
  }
};

type TransitionArgs = {
  id: string;
  transition: string;
  note?: string | null;
  actor: TaskActor;
  generationId?: string | null;
  runId?: string | null;
};

// Runs the atomic state change under a row lock: re-reads the committed state,
// re-validates the transition against it, evaluates the guard, applies the move,
// and appends the history record. Returns what the post-commit steps need.
const performTransitionTxn = async (args: {
  transitionArgs: TransitionArgs;
  transitions: WorkflowTransition[];
  states: WorkflowState[];
}): Promise<{
  previousDispatch: ActiveDispatch | null;
  toState: string;
  closed: boolean;
}> => {
  const { transitionArgs: a, transitions, states } = args;
  return db.sequelize.transaction(async (t) => {
    const task = (await db.Task.findOne({
      where: { publicId: a.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    })) as TaskInstance;

    if (task.status === 'closed') {
      throw new DomainError(
        'TASK_TRANSITION_CONFLICT',
        `Task '${a.id}' is closed and can no longer transition.`
      );
    }

    const fromState = task.state;
    const transition = findValidTransition({
      transitions,
      name: a.transition,
      fromState,
    });
    if (!transition) {
      throw new DomainError(
        'TASK_TRANSITION_CONFLICT',
        `Transition '${a.transition}' is not valid from state '${fromState}'.`,
        { transition: a.transition, fromState }
      );
    }

    evaluateGuard({ transition, task, actor: a.actor });

    const previousDispatch = task.activeDispatch as ActiveDispatch | null;
    const closed =
      stateByName({ states, name: transition.to })?.terminal === true;

    task.state = transition.to;
    task.status = closed ? 'closed' : 'open';
    task.enteredStateAt = new Date();
    // Entering a new state clears the prior dispatch provenance; the new state's
    // on_enter (if any) sets it again.
    task.activeDispatch = null;
    task.automationStatus = null;
    await task.save({ transaction: t });

    await db.TaskTransition.create(
      {
        taskId: task.id as number,
        fromState,
        toState: transition.to,
        transition: transition.name,
        actorKind: a.actor.kind,
        actorId: a.actor.id,
        generationId: a.generationId ?? null,
        runId: a.runId ?? null,
        note: a.note ?? null,
      },
      { transaction: t }
    );

    return { previousDispatch, toState: transition.to, closed };
  });
};

/**
 * The single path every task state change routes through — human, API,
 * automation outcome, approval resolution. Validates the transition exists,
 * applies it atomically under a row lock (guards enforced, history appended),
 * cancels any dispatch the task is leaving, emits events, and fires the new
 * state's on_enter automation.
 */
export const transitionTask = async (args: TransitionArgs) => {
  log(
    'transitionTask: id=%s transition=%s actor=%s',
    args.id,
    args.transition,
    args.actor.kind
  );

  const loaded = await findTaskInstance({ id: args.id });
  if (!loaded) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  const workflow = loaded.workflow!;
  const transitions = workflow.transitions as WorkflowTransition[];
  const states = workflow.states as WorkflowState[];
  const projectId = loaded.projectId as number;

  // The transition must exist in the definition at all (else 400 NOT_FOUND).
  if (
    !transitions.some((t) => {
      return t.name === args.transition;
    })
  ) {
    throw new DomainError(
      'TASK_TRANSITION_NOT_FOUND',
      `Transition '${args.transition}' does not exist in this workflow.`,
      { transition: args.transition }
    );
  }

  const result = await performTransitionTxn({
    transitionArgs: args,
    transitions,
    states,
  });

  await cancelDispatchOnExit({
    previous: result.previousDispatch,
    projectId,
  });

  const updated = await findTaskInstance({ id: args.id });
  const mapped = mapTask(updated!);

  await emitTaskEvent({
    type: 'tasks.transitioned',
    projectId,
    task: mapped,
    extra: { transition: args.transition, fromState: loaded.state },
  });
  if (result.closed) {
    await emitTaskEvent({ type: 'tasks.closed', projectId, task: mapped });
  }

  const toStateDef = stateByName({ states, name: result.toState });
  if (toStateDef) {
    dispatchOnEnter({ taskPublicId: args.id, projectId, state: toStateDef });
  }

  return mapped;
};
