import type { db } from 'src/db';

import type { TaskReadiness } from './taskReadiness';

type TaskRow = InstanceType<(typeof db)['Task']>;

/**
 * `task` as every workflow expression reads it: transition guards,
 * `on_enter` input mappings, `on_complete` rules and `payload_writes`.
 */
export const taskExpressionContext = (args: {
  task: TaskRow;
  readiness: TaskReadiness;
}) => {
  const { task } = args;
  return {
    id: task.publicId,
    title: task.title,
    state: task.state,
    status: task.status,
    payload: task.payload,
    assignee: task.assignee,
    // Server-owned, in its own namespace: an expression on `task.last_result`
    // can only be satisfied by a value an automation wrote.
    last_result: task.lastResult ?? null,
    readiness: args.readiness,
  };
};
