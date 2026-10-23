import createDebug from 'debug';

import { DomainError } from '../errors';
import { evaluateLogic } from './jsonLogicMapping';
import { type Page, pageOf } from './pagination';
import {
  findTaskInstance,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
import {
  findValidTransition,
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
    // only be satisfied by a value an automation wrote.
    last_result: task.lastResult ?? null,
  };
};

const guardRejection = (args: {
  transition: WorkflowTransition;
  task: TaskInstance;
  principal: TaskPrincipal;
}): DomainError | null => {
  if (args.transition.guard == null) return null;
  const ok = Boolean(
    evaluateLogic(args.transition.guard, {
      task: buildTaskContext(args.task),
      transition: { name: args.transition.name },
      principal: args.principal,
    })
  );
  if (ok) return null;
  return new DomainError(
    'TASK_GUARD_REJECTED',
    `The guard for transition '${args.transition.name}' rejected this move.`,
    { transition: args.transition.name }
  );
};

/**
 * Why firing `transition` on `task` as `principal` would be refused, or `null`
 * when it would be accepted. The one decision behind the write, the approval
 * park and the transition list, so the three cannot disagree.
 *
 * A `requires_approval` transition fired by anyone but `approval` parks rather
 * than moves, and the park defers the guard to resolution time.
 */
export const transitionRefusal = (args: {
  task: TaskInstance;
  transition: WorkflowTransition;
  transitions: WorkflowTransition[];
  principal: TaskPrincipal;
}): DomainError | null => {
  const { task, transition, principal } = args;
  if (task.status === 'closed') {
    return new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${task.publicId}' is closed and can no longer transition.`
    );
  }
  // A pending gate is a true park: only the `approval` principal, firing the
  // gated transition, moves the task out from under it.
  if (task.pendingTransition && principal.kind !== 'approval') {
    return new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Task '${task.publicId}' has transition '${task.pendingTransition}' pending approval.`,
      { pendingTransition: task.pendingTransition }
    );
  }
  const valid = findValidTransition({
    transitions: args.transitions,
    name: transition.name,
    fromState: task.state,
  });
  if (!valid) {
    return new DomainError(
      'TASK_TRANSITION_CONFLICT',
      `Transition '${transition.name}' is not valid from state '${task.state}'.`,
      { transition: transition.name, fromState: task.state }
    );
  }
  const parks =
    valid.requiresApproval === true && principal.kind !== 'approval';
  if (parks) return null;
  return guardRejection({ transition: valid, task, principal });
};

export const assertTransitionAllowed = (args: {
  task: TaskInstance;
  transition: WorkflowTransition;
  transitions: WorkflowTransition[];
  principal: TaskPrincipal;
}): void => {
  const refusal = transitionRefusal(args);
  if (refusal) throw refusal;
};

export type TransitionOption = {
  name: string;
  to: string;
  requires_approval: boolean;
  allowed: boolean;
  error_code: string | null;
};

/**
 * Every transition of the task's pinned machine with what firing it as
 * `principal` would answer now. Advisory: the fire re-validates under the lock.
 */
export const listTaskTransitions = async (args: {
  id: string;
  principal: TaskPrincipal;
  limit?: number;
  cursor?: string;
}): Promise<Page<TransitionOption>> => {
  log('listTaskTransitions: id=%s principal=%s', args.id, args.principal.kind);
  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  const { transitions } = await resolveTaskDefinition({
    task,
    workflow: task.workflow!,
  });
  const page = pageOf({
    items: transitions,
    limit: args.limit,
    cursor: args.cursor,
    filters: { id: args.id },
  });
  const data = page.data.map((transition) => {
    const refusal = transitionRefusal({
      task,
      transition,
      transitions,
      principal: args.principal,
    });
    return {
      name: transition.name,
      to: transition.to,
      requires_approval: transition.requiresApproval === true,
      allowed: refusal === null,
      error_code: refusal?.code ?? null,
    };
  });
  return { ...page, data };
};
