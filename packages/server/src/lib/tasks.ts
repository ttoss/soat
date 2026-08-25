import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { ResourceIncludes } from './modelIncludes';
import { paginatedList } from './pagination';
import type { RequestPrincipal } from './principals';
import { emitTaskEvent } from './taskEvents';
import { runStateAutomation } from './tasksAutomation';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
import {
  assertValidToolContextKeys,
  pinServerIdentityToolContext,
} from './toolContext';
import { validatePayload, type WorkflowState } from './workflowsValidation';

export { transitionTask } from './tasksTransition';

const log = createDebug('soat:tasks');

/**
 * Who moved a task. `principal`, not `actor`: the ids here come from Users and
 * API Keys, never from the Actors module. `automation` and `approval` are the
 * engine's own system principals.
 */
export type TaskPrincipalKind = 'user' | 'api_key' | 'automation' | 'approval';

export type TaskPrincipal = {
  kind: TaskPrincipalKind;
  /**
   * The principal's public id (`user_…` / `key_…`), or null when there is no
   * principal behind the move. Always null for `automation` — a generation or
   * orchestration run is a *cause*, and it is recorded as such in
   * `generationId` / `orchestrationRunId`.
   */
  id: string | null;
};

export type ActiveDispatch = {
  /**
   * What the state dispatched. `tool_call` (a `kind: tool` dispatch) always
   * carries a null `id`: a direct tool call leaves no addressable record the
   * way a generation or a run does.
   */
  kind: 'generation' | 'orchestration_run' | 'tool_call';
  id: string | null;
  status: string;
  /**
   * 1-based attempt number, present only while a state's `on_enter.retry`
   * policy is in effect — so a dispatch with no retry keeps exactly the shape it
   * had before retries existed (#822).
   */
  attempt?: number;
};

export type TaskInstance = InstanceType<(typeof db)['Task']> & {
  project?: InstanceType<(typeof db)['Project']>;
  workflow?: InstanceType<(typeof db)['Workflow']>;
};

export const mapTask = (instance: TaskInstance) => {
  return {
    id: instance.publicId,
    project_id: instance.project?.publicId,
    workflow_id: instance.workflow?.publicId,
    workflow_version: instance.workflowVersion,
    title: instance.title,
    state: instance.state,
    status: instance.status,
    payload: instance.payload,
    metadata: instance.metadata ?? null,
    last_result: instance.lastResult ?? null,
    assignee: instance.assignee,
    active_dispatch: instance.activeDispatch,
    automation_status: instance.automationStatus,
    automation_chain_depth: instance.automationChainDepth ?? 0,
    pending_transition: instance.pendingTransition,
    entered_state_at: instance.enteredStateAt,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
};

/**
 * Turns a caller-supplied `tool_context` into the bag to persist on the task:
 * validated against the header-name grammar every other entry point uses, with
 * the reserved identity keys stripped in any casing.
 *
 * The strip is belt-and-braces — `buildGenerationContext` re-pins identity at
 * the generation chokepoint (#850), so a forged `sessionId` could never reach a
 * tool header either way — but a task row is long-lived and read by operators,
 * and storing a key the server will overwrite would make the record lie about
 * what the dispatch will send.
 *
 * An empty bag (all-reserved, or a literal `{}`) persists as `null` rather than
 * `{}`: "no context" has one representation, and a caller can therefore drop a
 * credential from an open task by sending `tool_context: {}` without having to
 * close it.
 */
export const sanitizeTaskToolContext = (
  toolContext: Record<string, string> | null | undefined
): Record<string, string> | null => {
  if (!toolContext) return null;
  assertValidToolContextKeys(toolContext);
  const stripped = pinServerIdentityToolContext({
    toolContext,
    identity: null,
  });
  if (!stripped || Object.keys(stripped).length === 0) return null;
  return stripped;
};

/**
 * The wall-clock instant a task in `state` becomes stalled, or `null` when the
 * state declares no positive `stalled_after`. Computed from the state-entry
 * timestamp so the stall sweeper can select due tasks with a single indexed
 * range query rather than scanning every open task.
 */
export const computeStallDeadline = (args: {
  state: WorkflowState;
  enteredStateAt: Date;
}): Date | null => {
  const seconds = args.state.stalledAfter;
  if (typeof seconds !== 'number' || seconds <= 0) return null;
  return new Date(args.enteredStateAt.getTime() + seconds * 1000);
};

export const taskIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Workflow, as: 'workflow' },
  ];
};

export const findTaskInstance = async (args: {
  id: string;
}): Promise<TaskInstance | null> => {
  return (await db.Task.findOne({
    where: { publicId: args.id },
    include: taskIncludes(),
  })) as TaskInstance | null;
};

const findTask = async (args: { id: string }) => {
  const task = await findTaskInstance({ id: args.id });
  return task ? mapTask(task) : null;
};

export const getTask = async (args: { id: string }) => {
  const task = await findTask({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  return task;
};

export const listTasks = async (args: {
  projectIds: number[];
  workflowId?: string;
  state?: string;
  status?: string;
  assignee?: string;
  limit?: number;
  offset?: number;
}) => {
  log(
    'listTasks: projectIds=%o workflowId=%s state=%s status=%s',
    args.projectIds,
    args.workflowId,
    args.state,
    args.status
  );
  const where: Record<string, unknown> = { projectId: args.projectIds };
  if (args.state) where.state = args.state;
  if (args.status) where.status = args.status;
  if (args.assignee) where.assignee = args.assignee;

  if (args.workflowId) {
    const workflow = await db.Workflow.findOne({
      where: { publicId: args.workflowId },
    });
    // An unknown workflow filter yields an empty page rather than every task.
    where.workflowId = workflow ? (workflow.id as number) : -1;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Task.findAndCountAll({
        where,
        include: taskIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (t) => {
      return mapTask(t);
    },
  });
};

// ── Definition helpers ────────────────────────────────────────────────────────

export const stateByName = (args: {
  states: WorkflowState[];
  name: string;
}): WorkflowState | undefined => {
  return args.states.find((s) => {
    return s.name === args.name;
  });
};

const findInitialState = (states: WorkflowState[]): WorkflowState => {
  const initial = states.find((s) => {
    return s.initial === true;
  });
  if (!initial) {
    // Guarded by workflow validation on create/update, so this is defensive.
    throw new DomainError(
      'WORKFLOW_VALIDATION_FAILED',
      'Workflow has no initial state.'
    );
  }
  return initial;
};

// In-flight on_enter automations. Dispatch is fire-and-forget in production
// (nothing awaits it), but this lets callers that need determinism — tests, a
// graceful shutdown — drain the trailing async work via `flushTaskAutomations`
// rather than leaving DB writes in flight past teardown.
const pendingAutomations = new Set<Promise<void>>();

/**
 * Awaits every currently-pending on_enter automation, transitively: routing an
 * automation outcome can enter a new automated state, so it loops until the set
 * drains. Used by tests to avoid worker-teardown leaks from detached dispatch.
 */
export const flushTaskAutomations = async (): Promise<void> => {
  while (pendingAutomations.size > 0) {
    await Promise.allSettled([...pendingAutomations]);
  }
};

/** Kicks off a state's on_enter automation in the background, if any. */
export const dispatchOnEnter = (args: {
  taskPublicId: string;
  projectId: number;
  state: WorkflowState;
  // The identity the dispatch runs as, whichever kind it is. A task dispatch is
  // request-less — a run is always durable (never `wait`), and an agent
  // generation is fire-and-forget — so without one its `soat` tool nodes and
  // tools have no credential; see `orchestrationRunToken.ts`.
  principal?: RequestPrincipal;
}): void => {
  if (!args.state.onEnter || args.state.kind === 'human') return;
  const promise = runStateAutomation({
    taskPublicId: args.taskPublicId,
    projectId: args.projectId,
    stateName: args.state.name,
    onEnter: args.state.onEnter,
    principal: args.principal,
  })
    .catch((error: unknown) => {
      log(
        'dispatchOnEnter: automation failed task=%s %o',
        args.taskPublicId,
        error
      );
    })
    .finally(() => {
      pendingAutomations.delete(promise);
    });
  pendingAutomations.add(promise);
};

/**
 * Resolves a task's entry state: the named `state` when given (an alternate
 * entry point, #821), otherwise the workflow's `initial` state. Throws
 * `TASK_STATE_NOT_FOUND` when `state` names no declared state.
 */
const resolveEntryState = (args: {
  states: WorkflowState[];
  workflowId: string;
  state?: string | null;
}): WorkflowState => {
  if (!args.state) return findInitialState(args.states);
  const found = stateByName({ states: args.states, name: args.state });
  if (!found) {
    throw new DomainError(
      'TASK_STATE_NOT_FOUND',
      `Workflow '${args.workflowId}' has no state named '${args.state}'.`,
      { state: args.state }
    );
  }
  return found;
};

// ── Create ────────────────────────────────────────────────────────────────────

/** Emits `tasks.created`/`tasks.closed`, kicks off `on_enter`, and returns the mapped task. */
const finalizeCreatedTask = async (args: {
  taskPublicId: string;
  projectId: number;
  entryState: WorkflowState;
  closed: boolean;
  principal: TaskPrincipal;
}) => {
  const created = await findTaskInstance({ id: args.taskPublicId });
  const mapped = mapTask(created!);
  await emitTaskEvent({
    type: 'tasks.created',
    projectId: args.projectId,
    task: mapped,
  });
  if (args.closed) {
    await emitTaskEvent({
      type: 'tasks.closed',
      projectId: args.projectId,
      task: mapped,
    });
  }

  dispatchOnEnter({
    taskPublicId: args.taskPublicId,
    projectId: args.projectId,
    state: args.entryState,
    // The creator is the identity the entry state's automation acts as; every
    // later hop inherits it (see `resolveDispatchPrincipal`).
    principal:
      args.principal.kind === 'user' || args.principal.kind === 'api_key'
        ? args.principal.id
          ? {
              principalType: args.principal.kind,
              principalId: args.principal.id,
            }
          : undefined
        : undefined,
  });

  return mapped;
};

export const createTask = async (args: {
  projectId: number;
  workflowId: string;
  title: string;
  payload?: Record<string, unknown> | null;
  assignee?: string | null;
  /**
   * Alternate entry point: name a declared state to place the task there
   * instead of the workflow's `initial` state. Entering it behaves exactly
   * like arriving via a transition — `on_enter` fires, the stall clock arms —
   * so mid-flow entry is a different first state, not a second lifecycle.
   * Defaults to the `initial` state.
   */
  state?: string | null;
  /**
   * Caller context for the automation dispatches this task makes, forwarded as
   * `X-Soat-Context-*` headers on their tool calls (#950). Creation is the first
   * move, so this is the bag the entry state's `on_enter` runs with; each later
   * transition may replace it.
   */
  toolContext?: Record<string, string> | null;
  /**
   * Caller-owned annotations stored on the task and returned verbatim (#342).
   * Never read by a guard or written by a `payload_writes`, which is what makes
   * it the place for an attribution label rather than `payload`.
   */
  metadata?: Record<string, unknown>;
  principal: TaskPrincipal;
}) => {
  log(
    'createTask: projectId=%d workflowId=%s title=%s state=%s',
    args.projectId,
    args.workflowId,
    args.title,
    args.state
  );

  const workflow = await db.Workflow.findOne({
    where: { publicId: args.workflowId, projectId: args.projectId },
  });
  if (!workflow) {
    throw new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${args.workflowId}' not found.`
    );
  }

  const entryState = resolveEntryState({
    states: workflow.states as WorkflowState[],
    workflowId: args.workflowId,
    state: args.state,
  });
  const payload = (args.payload ?? {}) as Record<string, unknown>;
  validatePayload({ payloadSchema: workflow.payloadSchema, payload });

  const toolContext = sanitizeTaskToolContext(args.toolContext);
  const closed = entryState.terminal === true;
  const enteredStateAt = new Date();

  const task = await db.Task.create({
    projectId: args.projectId,
    workflowId: workflow.id as number,
    // The pin (#882): the task runs on this version of the state machine for its
    // whole life, however long the workflow is edited around it.
    workflowVersion: workflow.version,
    title: args.title,
    state: entryState.name,
    status: closed ? 'closed' : 'open',
    payload,
    metadata: args.metadata ?? null,
    assignee: args.assignee ?? null,
    // A task created straight into a terminal state dispatches nothing and can
    // never be moved again, so it never holds a credential at rest.
    toolContext: closed ? null : toolContext,
    activeDispatch: null,
    automationStatus: null,
    pendingTransition: null,
    pendingApprovalId: null,
    enteredStateAt,
    // A terminal entry state never stalls; otherwise arm the sweeper.
    stallDeadlineAt: closed
      ? null
      : computeStallDeadline({ state: entryState, enteredStateAt }),
  });

  await db.TaskTransition.create({
    taskId: task.id as number,
    fromState: null,
    toState: entryState.name,
    transition: null,
    principalKind: args.principal.kind,
    principalId: args.principal.id,
    generationId: null,
    orchestrationRunId: null,
    note: null,
  });

  return finalizeCreatedTask({
    taskPublicId: task.publicId,
    projectId: args.projectId,
    entryState,
    closed,
    principal: args.principal,
  });
};

// ── Update (payload / title / assignee — never state) ─────────────────────────

export const updateTask = async (args: {
  id: string;
  title?: string;
  payload?: Record<string, unknown>;
  assignee?: string | null;
}) => {
  log('updateTask: id=%s', args.id);

  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }

  if (args.payload !== undefined) {
    // PATCH semantics: shallow-merge the patch over the existing payload so a
    // caller setting one key (e.g. `approved`) does not discard the others
    // (including any `payload_writes` the workflow declared). The payload is
    // caller-owned; the automation result lives in the `last_result` column,
    // which no patch can reach (#846). The merged result is what gets
    // validated and persisted.
    const merged = {
      ...((task.payload as Record<string, unknown> | null) ?? {}),
      ...args.payload,
    };
    // Validated against the schema the task entered on, not the live one: a
    // schema tightened after the task was created would otherwise make an
    // in-flight task unpatchable (#882).
    const { payloadSchema } = await resolveTaskDefinition({
      task,
      workflow: task.workflow!,
    });
    validatePayload({ payloadSchema, payload: merged });
    task.payload = merged;
  }
  if (args.title !== undefined) task.title = args.title;
  if (args.assignee !== undefined) task.assignee = args.assignee;

  await task.save();

  const updated = await findTaskInstance({ id: args.id });
  return mapTask(updated!);
};

export const deleteTask = async (args: { id: string }) => {
  log('deleteTask: id=%s', args.id);
  const task = await db.Task.findOne({ where: { publicId: args.id } });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  await task.destroy();
};

// ── History ──────────────────────────────────────────────────────────────────

export const getTaskHistory = async (args: { id: string }) => {
  const task = await db.Task.findOne({ where: { publicId: args.id } });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  const rows = await db.TaskTransition.findAll({
    where: { taskId: task.id as number },
    order: [['createdAt', 'ASC']],
  });
  return rows.map((row) => {
    return {
      id: row.publicId,
      task_id: task.publicId,
      from_state: row.fromState,
      to_state: row.toState,
      transition: row.transition,
      principal_kind: row.principalKind,
      principal_id: row.principalId,
      generation_id: row.generationId,
      orchestration_run_id: row.orchestrationRunId,
      tool_id: row.toolId,
      note: row.note,
      created_at: row.createdAt,
    };
  });
};
