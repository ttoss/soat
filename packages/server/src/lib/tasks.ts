import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { paginatedList } from './pagination';
import { runStateAutomation } from './tasksAutomation';
import { validatePayload, type WorkflowState } from './workflowsValidation';

export { transitionTask } from './tasksTransition';

const log = createDebug('soat:tasks');

export type TaskActorKind = 'user' | 'api_key' | 'automation' | 'approval';

export type TaskActor = {
  kind: TaskActorKind;
  id: string | null;
};

export type ActiveDispatch = {
  kind: 'generation' | 'orchestration_run';
  id: string | null;
  status: string;
};

export type TaskInstance = InstanceType<(typeof db)['Task']> & {
  project?: InstanceType<(typeof db)['Project']>;
  workflow?: InstanceType<(typeof db)['Workflow']>;
};

export const mapTask = (instance: TaskInstance) => {
  return {
    id: instance.publicId,
    projectId: instance.project?.publicId,
    workflowId: instance.workflow?.publicId,
    title: instance.title,
    state: instance.state,
    status: instance.status,
    payload: instance.payload,
    assignee: instance.assignee,
    activeDispatch: instance.activeDispatch,
    automationStatus: instance.automationStatus,
    pendingTransition: instance.pendingTransition,
    enteredStateAt: instance.enteredStateAt,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
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

const taskIncludes = () => {
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

export const findTask = async (args: { id: string }) => {
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

// ── Event emission ──────────────────────────────────────────────────────────

export const emitTaskEvent = async (args: {
  type: string;
  projectId: number;
  task: ReturnType<typeof mapTask>;
  extra?: Record<string, unknown>;
}): Promise<void> => {
  const projectPublicId = await resolveProjectPublicId({
    projectId: args.projectId,
  });
  emitEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId,
    resourceType: 'task',
    resourceId: args.task.id,
    data: { task: args.task, ...(args.extra ?? {}) },
    timestamp: new Date().toISOString(),
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
}): void => {
  if (!args.state.onEnter || args.state.kind === 'human') return;
  const promise = runStateAutomation({
    taskPublicId: args.taskPublicId,
    projectId: args.projectId,
    stateName: args.state.name,
    onEnter: args.state.onEnter,
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

// ── Create ────────────────────────────────────────────────────────────────────

export const createTask = async (args: {
  projectId: number;
  workflowId: string;
  title: string;
  payload?: Record<string, unknown> | null;
  assignee?: string | null;
  actor: TaskActor;
}) => {
  log(
    'createTask: projectId=%d workflowId=%s title=%s',
    args.projectId,
    args.workflowId,
    args.title
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

  const states = workflow.states as WorkflowState[];
  const initial = findInitialState(states);
  const payload = (args.payload ?? {}) as Record<string, unknown>;
  validatePayload({ payloadSchema: workflow.payloadSchema, payload });

  const closed = initial.terminal === true;
  const enteredStateAt = new Date();

  const task = await db.Task.create({
    projectId: args.projectId,
    workflowId: workflow.id as number,
    title: args.title,
    state: initial.name,
    status: closed ? 'closed' : 'open',
    payload,
    assignee: args.assignee ?? null,
    activeDispatch: null,
    automationStatus: null,
    pendingTransition: null,
    pendingApprovalId: null,
    enteredStateAt,
    // A terminal initial state never stalls; otherwise arm the sweeper.
    stallDeadlineAt: closed
      ? null
      : computeStallDeadline({ state: initial, enteredStateAt }),
  });

  await db.TaskTransition.create({
    taskId: task.id as number,
    fromState: null,
    toState: initial.name,
    transition: null,
    actorKind: args.actor.kind,
    actorId: args.actor.id,
    generationId: null,
    runId: null,
    note: null,
  });

  const created = await findTaskInstance({ id: task.publicId });
  const mapped = mapTask(created!);
  await emitTaskEvent({
    type: 'tasks.created',
    projectId: args.projectId,
    task: mapped,
  });
  if (closed) {
    await emitTaskEvent({
      type: 'tasks.closed',
      projectId: args.projectId,
      task: mapped,
    });
  }

  dispatchOnEnter({
    taskPublicId: task.publicId,
    projectId: args.projectId,
    state: initial,
  });

  return mapped;
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
    // caller setting one key (e.g. `approved`) does not discard keys an
    // on_enter automation wrote (e.g. `last_result`). The merged result is
    // what gets validated and persisted.
    const merged = {
      ...((task.payload as Record<string, unknown> | null) ?? {}),
      ...args.payload,
    };
    validatePayload({
      payloadSchema: task.workflow?.payloadSchema,
      payload: merged,
    });
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
      taskId: task.publicId,
      fromState: row.fromState,
      toState: row.toState,
      transition: row.transition,
      actorKind: row.actorKind,
      actorId: row.actorId,
      generationId: row.generationId,
      runId: row.runId,
      note: row.note,
      createdAt: row.createdAt,
    };
  });
};
