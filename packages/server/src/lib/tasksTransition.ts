import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { evaluateLogic } from './jsonLogicMapping';
import type { RequestPrincipal } from './principals';
import { emitTaskEvent } from './taskEvents';
import {
  type ActiveDispatch,
  computeStallDeadline,
  dispatchOnEnter,
  findTaskInstance,
  mapTask,
  sanitizeTaskToolContext,
  stateByName,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';
import { parkTransitionForApproval } from './tasksApprovalGate';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
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
    // Server-owned, in its own namespace: a guard on `task.last_result` can
    // only be satisfied by a value an automation wrote (#846).
    last_result: task.lastResult ?? null,
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

// An `automation` transition always carries `principal.id === null` (#786) —
// the cause lives in `generationId` / `orchestrationRunId` instead. If both of
// those are also null, nothing at all records why the task moved: not a
// degraded record, a meaningless one. Reject the write rather than silently
// persisting it (#792).
const assertAutomationHasProvenance = (args: {
  transitionArgs: TransitionArgs;
  transitionName: string;
}): void => {
  const { transitionArgs: a, transitionName } = args;
  const hasNoProvenance =
    a.principal.id == null &&
    a.generationId == null &&
    a.orchestrationRunId == null;
  if (a.principal.kind === 'automation' && hasNoProvenance) {
    throw new DomainError(
      'TASK_AUTOMATION_PROVENANCE_MISSING',
      `Automation transition '${transitionName}' for task '${a.id}' has no recorded cause (no principal, generation, or orchestration run id).`,
      { transition: transitionName, taskId: a.id }
    );
  }
};

const evaluateGuard = (args: {
  transition: WorkflowTransition;
  task: TaskInstance;
  principal: TaskPrincipal;
}): void => {
  if (args.transition.guard == null) return;
  const ok = Boolean(
    evaluateLogic(args.transition.guard, {
      task: buildTaskContext(args.task),
      transition: { name: args.transition.name },
      principal: args.principal,
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
  principal: TaskPrincipal;
  generationId?: string | null;
  orchestrationRunId?: string | null;
  /**
   * True when the caller authenticated with a run-as token (`ctx.authUser
   * .isRunToken`). Such a move is a dispatch's own `soat` tool acting as the
   * principal that started the chain — machinery continuing the work, not a
   * person directing it — even though it names a user or an API key on the wire.
   * Without this the composed cycle is invisible here; see `isChainHop`.
   */
  viaRunToken?: boolean;
  /**
   * Caller context for the dispatches the task makes from here on (#950).
   *
   * The precedence rule is the whole rule: **supplying one replaces the stored
   * bag wholesale; omitting it (`undefined`) keeps what the task already has.**
   * So the credential a dispatch runs with belongs to whoever last moved the
   * task — the same principal `resolveDispatchPrincipal` already makes it run as
   * — and a bag survives every move that does not speak about it, which is what
   * carries it across an approval gate, a retry and an automation hop.
   *
   * An explicit `{}` clears it (see `sanitizeTaskToolContext`).
   */
  toolContext?: Record<string, string> | null;
};

/** How far a task may travel on automation alone before the engine refuses. */
const DEFAULT_CHAIN_LIMIT = 50;

const chainLimit = (): number => {
  const configured = Number(process.env.TASK_AUTOMATION_CHAIN_LIMIT);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CHAIN_LIMIT;
};

/**
 * Whether this move continues a machine-driven chain rather than starting one.
 *
 * Two shapes qualify, and both are needed because the loop #885 bounds can close
 * through either:
 *
 * - an `automation` principal — the engine routing a dispatch outcome through
 *   `on_complete` / `on_failure`;
 * - a run-as token — the dispatched run or agent calling `transition-task` with
 *   the credential it was minted, which authenticates as the *user* who started
 *   the chain and is otherwise indistinguishable from a person clicking a
 *   button.
 *
 * Everything else — a human, a plain API key, an approval resolution — is an
 * outside intervention and resets the chain. `approval` in particular is not a
 * hop: a person deciding a gate is the clearest evidence there is that the task
 * is not spinning unattended.
 */
const isChainHop = (args: TransitionArgs): boolean => {
  return args.principal.kind === 'automation' || args.viaRunToken === true;
};

/**
 * Applies the chain budget to the locked task and returns the depth to persist.
 * Throws once the chain would exceed the limit, so the refusal lands *before*
 * the state change — the next `on_enter` never fires, which is what actually
 * breaks the cycle.
 */
const nextChainDepth = (args: {
  task: TaskInstance;
  transitionArgs: TransitionArgs;
  transitionName: string;
}): number => {
  if (!isChainHop(args.transitionArgs)) return 0;

  const limit = chainLimit();
  const next = (args.task.automationChainDepth ?? 0) + 1;
  if (next > limit) {
    throw new DomainError(
      'TASK_AUTOMATION_CHAIN_LIMIT',
      `Task '${args.transitionArgs.id}' has run ${limit} automated transitions with no outside intervention; '${args.transitionName}' was refused to break the cycle.`,
      {
        transition: args.transitionName,
        taskId: args.transitionArgs.id,
        limit,
      }
    );
  }
  return next;
};

// Validates the just-locked task against the requested transition: not closed,
// not fenced behind a pending approval gate (unless this is the `approval`
// resolution), the transition is valid from the committed state, and its guard
// passes. Returns the resolved transition or throws.
const resolveLockedTransition = (args: {
  task: TaskInstance;
  transitionArgs: TransitionArgs;
  transitions: WorkflowTransition[];
}): WorkflowTransition => {
  const { task, transitionArgs: a, transitions } = args;
  if (task.status === 'closed') {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${a.id}' is closed and can no longer transition.`
    );
  }
  // While a transition is parked awaiting approval the task is a true park: no
  // principal may move it out from under the pending gate. Only the `approval`
  // principal (the resolution firing the gated transition) passes.
  if (task.pendingTransition && a.principal.kind !== 'approval') {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${a.id}' has transition '${task.pendingTransition}' pending approval.`,
      { pendingTransition: task.pendingTransition }
    );
  }
  const transition = findValidTransition({
    transitions,
    name: a.transition,
    fromState: task.state,
  });
  if (!transition) {
    throw new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Transition '${a.transition}' is not valid from state '${task.state}'.`,
      { transition: a.transition, fromState: task.state }
    );
  }
  evaluateGuard({ transition, task, principal: a.principal });
  return transition;
};

// Runs the atomic state change under a row lock: re-reads the committed state,
// re-validates the transition against it, evaluates the guard, applies the move,
// and appends the history record. Returns what the post-commit steps need.
const performTransitionTxn = async (args: {
  transitionArgs: TransitionArgs;
  transitions: WorkflowTransition[];
  states: WorkflowState[];
  /**
   * The already-sanitized bag to persist, or `undefined` to leave the stored one
   * alone. Sanitized by the caller so an invalid key is a rejected write rather
   * than a throw from inside the locked transaction.
   */
  toolContext: Record<string, string> | null | undefined;
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

    const transition = resolveLockedTransition({
      task,
      transitionArgs: a,
      transitions,
    });

    // Before any mutation: a refused chain hop must leave the task exactly where
    // it was, with its dispatch provenance intact for whoever comes to look.
    const chainDepth = nextChainDepth({
      task,
      transitionArgs: a,
      transitionName: transition.name,
    });

    const fromState = task.state;
    const previousDispatch = task.activeDispatch as ActiveDispatch | null;
    const toStateDef = stateByName({ states, name: transition.to });
    const closed = toStateDef?.terminal === true;
    const enteredStateAt = new Date();
    task.state = transition.to;
    task.status = closed ? 'closed' : 'open';
    task.enteredStateAt = enteredStateAt;
    // Entering a new state clears the prior dispatch provenance; the new state's
    // on_enter (if any) sets it again.
    task.activeDispatch = null;
    task.automationStatus = null;
    task.automationChainDepth = chainDepth;
    // The gate (if any) is discharged by this move; clear it. Re-arm the stall
    // sweeper for the new state.
    task.pendingTransition = null;
    task.pendingApprovalId = null;
    // Last writer wins, and a terminal move scrubs: a closed task can never
    // dispatch again, so keeping the bag would only park a credential at rest.
    if (closed) {
      task.toolContext = null;
    } else if (args.toolContext !== undefined) {
      task.toolContext = args.toolContext;
    }
    task.stallDeadlineAt =
      closed || !toStateDef
        ? null
        : computeStallDeadline({ state: toStateDef, enteredStateAt });
    await task.save({ transaction: t });

    assertAutomationHasProvenance({
      transitionArgs: a,
      transitionName: transition.name,
    });

    await db.TaskTransition.create(
      {
        taskId: task.id as number,
        fromState,
        toState: transition.to,
        transition: transition.name,
        principalKind: a.principal.kind,
        principalId: a.principal.id,
        generationId: a.generationId ?? null,
        orchestrationRunId: a.orchestrationRunId ?? null,
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
/**
 * The identity the *next* state's automation runs as.
 *
 * A human or API-key move names itself. An `automation` move names nobody — its
 * cause is the generation or run recorded alongside it — so the identity is
 * inherited from the orchestration run that routed the task here. That is what
 * keeps a chain alive across states: a user fires the first transition, and
 * every automated hop after it continues to act as that user rather than
 * decaying to no principal at the second state.
 *
 * `approval` is deliberately not mapped: an approver resolving a gate is not
 * lending their credential to the work the next state does.
 */
const resolveDispatchPrincipal = async (
  args: TransitionArgs
): Promise<RequestPrincipal | undefined> => {
  const { kind, id } = args.principal;
  if ((kind === 'user' || kind === 'api_key') && id) {
    return { principalType: kind, principalId: id };
  }
  if (!args.orchestrationRunId) return undefined;
  const run = await db.OrchestrationRun.findOne({
    where: { publicId: args.orchestrationRunId },
    attributes: ['principalKind', 'principalId'],
  });
  const runKind = run?.principalKind;
  const runId = run?.principalId;
  if ((runKind !== 'user' && runKind !== 'api_key') || !runId) return undefined;
  return { principalType: runKind, principalId: runId };
};

export const transitionTask = async (args: TransitionArgs) => {
  log(
    'transitionTask: id=%s transition=%s principal=%s',
    args.id,
    args.transition,
    args.principal.kind
  );

  const loaded = await findTaskInstance({ id: args.id });
  if (!loaded) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  // The machine the task entered on, not the one the workflow holds now (#882).
  const { states, transitions } = await resolveTaskDefinition({
    task: loaded,
    workflow: loaded.workflow!,
  });
  const projectId = loaded.projectId as number;

  // The transition must exist in the definition at all (else 400 NOT_FOUND).
  const definition = transitions.find((t) => {
    return t.name === args.transition;
  });
  if (!definition) {
    throw new DomainError(
      'TASK_TRANSITION_NOT_FOUND',
      `Transition '${args.transition}' does not exist in this workflow.`,
      { transition: args.transition }
    );
  }

  // Sanitized before anything is claimed or locked: a key that could not become
  // a header must be a rejected write the caller is still listening for, not a
  // throw from inside the transaction (or after the approval gate is claimed).
  const toolContext =
    args.toolContext === undefined
      ? undefined
      : sanitizeTaskToolContext(args.toolContext);

  // Approval-gated: a `requires_approval` transition fired by anyone other than
  // the `approval` principal (the resolution itself) parks as an ApprovalItem
  // instead of applying. The gated move is re-fired here as the `approval`
  // principal when the item resolves, so guards are re-evaluated against the
  // committed state at resolution time (§6.5).
  if (
    definition.requiresApproval === true &&
    args.principal.kind !== 'approval'
  ) {
    return parkTransitionForApproval({
      task: loaded,
      transition: definition,
      // The gate re-checks validity against the same pinned machine this
      // transition was resolved from, never the live workflow row.
      transitions,
      note: args.note ?? null,
      // The gate is a pause, not a cancellation: the requester's context is
      // persisted now so the dispatch that runs when the gate resolves — under
      // the `approval` principal, which supplies none of its own — still carries
      // the credential the move was made with.
      toolContext,
    });
  }

  const result = await performTransitionTxn({
    transitionArgs: args,
    transitions,
    states,
    toolContext,
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
    dispatchOnEnter({
      taskPublicId: args.id,
      projectId,
      state: toStateDef,
      principal: await resolveDispatchPrincipal(args),
    });
  }

  return mapped;
};
