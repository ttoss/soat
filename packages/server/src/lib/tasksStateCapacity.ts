import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { lockForTransaction } from './advisoryLocks';
import type { Transaction } from './dbTransaction';
import type { WorkflowState } from './workflowsValidation';

const log = createDebug('soat:tasks');

/**
 * A state's `max_tasks`: the open tasks of the workflow in that state, across
 * every version, against the limit the entering task's version declares.
 * Every entry into a state (create, transition, migration) asks here.
 */

type CapacityArgs = {
  workflowDbId: number;
  state: WorkflowState;
  /** The entering task, which never takes a slot from itself. */
  taskId?: number;
};

const fullStateError = (args: {
  state: WorkflowState;
  maxTasks: number;
}): DomainError => {
  return new DomainError(
    'TASK_STATE_FULL',
    `State '${args.state.name}' already holds its limit of ${args.maxTasks} open tasks.`,
    { state: args.state.name, max_tasks: args.maxTasks }
  );
};

const openTasksIn = (
  args: CapacityArgs & { transaction?: Transaction }
): Promise<number> => {
  return db.Task.count({
    where: {
      workflowId: args.workflowDbId,
      state: args.state.name,
      status: 'open',
      ...(args.taskId === undefined ? {} : { id: { [Op.ne]: args.taskId } }),
    },
    transaction: args.transaction,
  });
};

/**
 * Why entering `state` would be refused, or `null`. Inside a transaction the
 * count is serialized per workflow until it ends, so two entries racing for
 * the last slot cannot both count it free; outside one it is advisory.
 */
export const stateCapacityRefusal = async (
  args: CapacityArgs & { transaction?: Transaction }
): Promise<DomainError | null> => {
  const maxTasks = args.state.maxTasks;
  if (maxTasks == null) return null;
  log(
    'stateCapacityRefusal: workflowDbId=%d state=%s maxTasks=%d',
    args.workflowDbId,
    args.state.name,
    maxTasks
  );
  if (args.transaction) {
    await lockForTransaction({
      sequelize: db.sequelize,
      transaction: args.transaction,
      namespace: 'workflowStateCapacity',
      id: args.workflowDbId,
    });
  }
  return (await openTasksIn(args)) >= maxTasks
    ? fullStateError({ state: args.state, maxTasks })
    : null;
};

/** Refuses an entry into a full state, serialized as above. */
export const assertStateHasRoom = async (
  args: CapacityArgs & { transaction: Transaction }
): Promise<void> => {
  const refusal = await stateCapacityRefusal(args);
  if (refusal) throw refusal;
};
