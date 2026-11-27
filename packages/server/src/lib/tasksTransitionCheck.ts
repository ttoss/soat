import createDebug from 'debug';

import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { evaluateLogic } from './jsonLogicMapping';
import { type Page, pageOf } from './pagination';
import { taskExpressionContext } from './taskExpressionContext';
import { readinessOfTask, type TaskReadiness } from './taskReadiness';
import {
  findTaskInstance,
  stateByName,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';
import { stateCapacityRefusal } from './tasksStateCapacity';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
import {
  findValidTransition,
  type WorkflowState,
  type WorkflowTransition,
} from './workflowsValidation';

const log = createDebug('soat:tasks');

const guardRejection = (args: {
  transition: WorkflowTransition;
  task: TaskInstance;
  readiness: TaskReadiness;
  principal: TaskPrincipal;
}): DomainError | null => {
  if (args.transition.guard == null) return null;
  const ok = Boolean(
    evaluateLogic(args.transition.guard, {
      task: taskExpressionContext({
        task: args.task,
        readiness: args.readiness,
      }),
      transition: { name: args.transition.name },
      principal: { kind: args.principal.kind, id: args.principal.id },
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
 * than moves, and the park defers the guard and the target's `max_tasks` to
 * resolution time.
 */
const transitionRefusal = async (args: {
  task: TaskInstance;
  readiness: TaskReadiness;
  transition: WorkflowTransition;
  transitions: WorkflowTransition[];
  states: WorkflowState[];
  principal: TaskPrincipal;
  /** Given, the target's `max_tasks` is counted under its lock. */
  transaction?: Transaction;
}): Promise<DomainError | null> => {
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
      { pending_transition: task.pendingTransition }
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
      { transition: transition.name, from_state: task.state }
    );
  }
  const parks =
    valid.requiresApproval === true && principal.kind !== 'approval';
  if (parks) return null;
  const rejected = guardRejection({
    transition: valid,
    task,
    readiness: args.readiness,
    principal,
  });
  if (rejected) return rejected;
  const target = stateByName({ states: args.states, name: valid.to });
  if (!target) return null;
  return stateCapacityRefusal({
    workflowDbId: task.workflowId as number,
    state: target,
    taskId: task.id as number,
    transaction: args.transaction,
  });
};

export const assertTransitionAllowed = async (args: {
  task: TaskInstance;
  transition: WorkflowTransition;
  transitions: WorkflowTransition[];
  states: WorkflowState[];
  principal: TaskPrincipal;
  transaction?: Transaction;
}): Promise<void> => {
  const refusal = await transitionRefusal({
    ...args,
    readiness: await readinessOfTask({
      taskId: args.task.id as number,
      transaction: args.transaction,
    }),
  });
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
  const { transitions, states } = await resolveTaskDefinition({
    task,
    workflow: task.workflow!,
  });
  const page = pageOf({
    items: transitions,
    limit: args.limit,
    cursor: args.cursor,
    filters: { id: args.id },
  });
  const readiness = await readinessOfTask({ taskId: task.id as number });
  const data = await Promise.all(
    page.data.map(async (transition) => {
      const refusal = await transitionRefusal({
        task,
        readiness,
        transition,
        transitions,
        states,
        principal: args.principal,
      });
      return {
        name: transition.name,
        to: transition.to,
        requires_approval: transition.requiresApproval === true,
        allowed: refusal === null,
        error_code: refusal?.code ?? null,
      };
    })
  );
  return { ...page, data };
};
