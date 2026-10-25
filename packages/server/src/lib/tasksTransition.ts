import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { claimIdempotencyKey } from './idempotencyClaim';
import type { RequestPrincipal } from './principals';
import { emitTaskEvent } from './taskEvents';
import {
  type ActiveDispatch,
  computeStallDeadline,
  dispatchOnEnter,
  findTaskInstance,
  mapTask,
  mergeTaskPayload,
  stateByName,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';
import { parkTransitionForApproval } from './tasksApprovalGate';
import { assertTransitionAllowed } from './tasksTransitionCheck';
import {
  findTransitionClaim,
  type TransitionIdempotency,
} from './tasksTransitionIdempotency';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
import { acceptStoredToolContextUpdate } from './toolContextCarrier';
import type { WorkflowState, WorkflowTransition } from './workflowsValidation';

const log = createDebug('soat:tasks');

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

// An `automation` transition carries no principal id — the cause lives
// in `generationId`/`orchestrationRunId`/`toolId`. With all of those null,
// nothing records why the task moved, so the write is rejected.
const assertAutomationHasProvenance = (args: {
  transitionArgs: TransitionArgs;
  transitionName: string;
}): void => {
  const { transitionArgs: a, transitionName } = args;
  const hasNoProvenance =
    a.principal.id == null &&
    a.generationId == null &&
    a.orchestrationRunId == null &&
    a.toolId == null;
  if (a.principal.kind === 'automation' && hasNoProvenance) {
    throw new DomainError(
      'TASK_AUTOMATION_PROVENANCE_MISSING',
      `Automation transition '${transitionName}' for task '${a.id}' has no recorded cause (no principal, generation, or orchestration run id).`,
      { transition: transitionName, task_id: a.id }
    );
  }
};

/**
 * The three provenance columns, one per dispatch kind — exactly one of which an
 * automation move carries (`assertAutomationHasProvenance` above rejects a move
 * with none). Built here rather than inline so adding a kind does not push the
 * transaction body past its complexity budget.
 */
const dispatchProvenance = (a: TransitionArgs) => {
  return {
    generationId: a.generationId ?? null,
    orchestrationRunId: a.orchestrationRunId ?? null,
    toolId: a.toolId ?? null,
  };
};

type TransitionArgs = {
  id: string;
  transition: string;
  note?: string | null;
  principal: TaskPrincipal;
  generationId?: string | null;
  orchestrationRunId?: string | null;
  /** The tool a `tool` dispatch called — that kind's only recorded cause. */
  toolId?: string | null;
  /**
   * True when the caller authenticated with a run-as token (`ctx.authUser
   * .isRunToken`). Such a move is a dispatch's own `soat` tool acting as the
   * principal that started the chain — machinery continuing the work, not a
   * person directing it — even though it names a user or an API key on the wire.
   * Without this the composed cycle is invisible here; see `isChainHop`.
   */
  viaRunToken?: boolean;
  /**
   * Caller context for the dispatches the task makes from here on.
   *
   * The precedence rule is the whole rule: **supplying one replaces the stored
   * bag wholesale; omitting it (`undefined`) keeps what the task already has.**
   * So the credential a dispatch runs with belongs to whoever last moved the
   * task — the same principal `resolveDispatchPrincipal` already makes it run as
   * — and a bag survives every move that does not speak about it, which is what
   * carries it across an approval gate, a retry and an automation hop.
   *
   * An explicit `{}` clears it.
   */
  toolContext?: Record<string, string> | null;
  /**
   * The caller's deduplication key and request digest. A move the key already
   * names on this task replays the task instead of moving it again.
   */
  idempotency?: TransitionIdempotency;
  /**
   * Keys merged over the payload under the transition's lock before the guard
   * reads it, as `PATCH` merges them. A refused move writes none of it.
   */
  payload?: Record<string, unknown>;
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
 * Two shapes qualify, because the bounded loop can close through either: an
 * `automation` principal (the engine routing a dispatch outcome), and a
 * run-as token (the dispatched run calling `transition-task` with the
 * credential it was minted, which authenticates as the user who started the
 * chain and is otherwise indistinguishable from a person clicking a button).
 *
 * Everything else — a human, a plain API key, an approval resolution — is an
 * outside intervention and resets the chain. `approval` in particular is the
 * clearest evidence there is that the task is not spinning unattended.
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
        task_id: args.transitionArgs.id,
        limit,
      }
    );
  }
  return next;
};

// Re-validates the move against the committed, locked state, with the move's
// payload merged in first so the guard reads what the caller sent.
const resolveLockedTransition = (args: {
  task: TaskInstance;
  transitionArgs: TransitionArgs;
  transitions: WorkflowTransition[];
  payloadSchema: unknown;
}): WorkflowTransition => {
  const { task, transitionArgs: a, transitions } = args;
  const transition = transitions.find((t) => {
    return t.name === a.transition;
  })!;
  if (a.payload) {
    task.payload = mergeTaskPayload({
      stored: task.payload as Record<string, unknown> | null,
      patch: a.payload,
      payloadSchema: args.payloadSchema,
    });
  }
  assertTransitionAllowed({
    task,
    transition,
    transitions,
    principal: a.principal,
  });
  return transition;
};

// Under the lock, so a retry racing its original waits for it and replays
// rather than being refused by the state the original moved to.
const claimedUnderLock = async (args: {
  task: TaskInstance;
  transitionArgs: TransitionArgs;
  transaction: Transaction;
}): Promise<boolean> => {
  const claim = args.transitionArgs.idempotency;
  if (!claim) return false;
  return findTransitionClaim({
    taskId: args.task.id as number,
    taskPublicId: args.task.publicId,
    claim,
    transaction: args.transaction,
  });
};

const appendHistory = async (args: {
  taskId: number;
  fromState: string;
  transition: WorkflowTransition;
  transitionArgs: TransitionArgs;
  transaction: Transaction;
}): Promise<void> => {
  const a = args.transitionArgs;
  assertAutomationHasProvenance({
    transitionArgs: a,
    transitionName: args.transition.name,
  });
  await db.TaskTransition.create(
    {
      taskId: args.taskId,
      fromState: args.fromState,
      toState: args.transition.to,
      transition: args.transition.name,
      principalType: a.principal.kind,
      principalId: a.principal.id,
      ...dispatchProvenance(a),
      note: a.note ?? null,
      idempotencyKey: a.idempotency?.key ?? null,
      idempotencyDigest: a.idempotency?.digest ?? null,
    },
    { transaction: args.transaction }
  );
};

// Runs the atomic state change under a row lock: re-reads the committed state,
// re-validates the transition against it, evaluates the guard, applies the move,
// and appends the history record. Returns what the post-commit steps need.
const performTransitionTxn = async (args: {
  transitionArgs: TransitionArgs;
  transitions: WorkflowTransition[];
  states: WorkflowState[];
  payloadSchema: unknown;
  /**
   * The already-sanitized bag to persist, or `undefined` to leave the stored one
   * alone. Sanitized by the caller so an invalid key is a rejected write rather
   * than a throw from inside the locked transaction.
   */
  toolContext: Record<string, string> | null | undefined;
}): Promise<
  | { replayed: true }
  | {
      replayed: false;
      previousDispatch: ActiveDispatch | null;
      toState: string;
      closed: boolean;
    }
> => {
  const { transitionArgs: a, transitions, states } = args;
  return db.sequelize.transaction(async (t) => {
    const task = (await db.Task.findOne({
      where: { publicId: a.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    })) as TaskInstance;

    if (await claimedUnderLock({ task, transitionArgs: a, transaction: t })) {
      return { replayed: true as const };
    }

    const transition = resolveLockedTransition({
      task,
      transitionArgs: a,
      transitions,
      payloadSchema: args.payloadSchema,
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

    await appendHistory({
      taskId: task.id as number,
      fromState,
      transition,
      transitionArgs: a,
      transaction: t,
    });

    return {
      replayed: false as const,
      previousDispatch,
      toState: transition.to,
      closed,
    };
  });
};

/**
 * The identity the *next* state's automation runs as.
 *
 * A human or API-key move names itself. An `automation` move names nobody — its
 * cause is the generation or run recorded alongside it — so the identity is
 * inherited from the run that routed the task here, which is what keeps a chain
 * acting as the user who fired the first transition rather than decaying to no
 * principal at the second state.
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

const currentTask = async (id: string) => {
  return mapTask((await findTaskInstance({ id }))!);
};

const applyTransition = async (input: {
  args: TransitionArgs;
  loaded: TaskInstance;
  definition: WorkflowTransition;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  payloadSchema: unknown;
}) => {
  const { args, loaded, definition, states, transitions, payloadSchema } =
    input;
  const projectId = loaded.projectId as number;

  // Accepted before anything is claimed or locked: a key that could not become
  // a header must be a rejected write the caller is still listening for, not a
  // throw from inside the transaction (or after the approval gate is claimed).
  const toolContext = await acceptStoredToolContextUpdate({
    toolContext: args.toolContext,
    secretRefs: 'verbatim',
  });

  // A `requires_approval` transition parks as an ApprovalItem unless fired by
  // the `approval` principal, i.e. the resolution re-firing it — so guards are
  // re-evaluated against the state committed at resolution time.
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
      principal: args.principal,
      note: args.note ?? null,
      // A pause, not a cancellation: the requester's context is persisted so
      // the dispatch that runs on resolution — under the `approval` principal,
      // which supplies none — still carries the credential the move used.
      toolContext,
      idempotency: args.idempotency,
      payload: args.payload,
      payloadSchema,
    });
  }

  const result = await performTransitionTxn({
    transitionArgs: args,
    transitions,
    states,
    payloadSchema,
    toolContext,
  });
  if (result.replayed) return currentTask(args.id);

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
    facts: { transition: args.transition, from_state: loaded.state },
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

/**
 * The single path every task state change routes through — human, API,
 * automation outcome, approval resolution. Validates the transition exists,
 * applies it atomically under a row lock (guards enforced, history appended),
 * cancels any dispatch the task is leaving, emits events, and fires the new
 * state's on_enter automation.
 */
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
  // The machine the task entered on, not the one the workflow holds now.
  const { states, transitions, payloadSchema } = await resolveTaskDefinition({
    task: loaded,
    workflow: loaded.workflow!,
  });

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

  const apply = () => {
    return applyTransition({
      args,
      loaded,
      definition,
      states,
      transitions,
      payloadSchema,
    });
  };
  const claim = args.idempotency;
  if (!claim) return apply();

  const claimed = await claimIdempotencyKey({
    replay: async () => {
      const found = await findTransitionClaim({
        taskId: loaded.id as number,
        taskPublicId: args.id,
        claim,
      });
      return found ? currentTask(args.id) : null;
    },
    create: apply,
  });
  return 'created' in claimed ? claimed.created : claimed.replayed;
};
