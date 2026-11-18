import type { db } from 'src/db';

type TaskRow = Pick<
  InstanceType<(typeof db)['Task']>,
  | 'publicId'
  | 'title'
  | 'state'
  | 'status'
  | 'payload'
  | 'assignee'
  | 'priority'
  | 'lastResult'
>;

/**
 * The `task` a transition guard, an automation's `on_complete` rules and its
 * `payload_writes` read. One shape, so a field a guard can name is the same
 * on every path that evaluates one.
 */
export const taskGuardContext = (task: TaskRow) => {
  return {
    id: task.publicId,
    title: task.title,
    state: task.state,
    status: task.status,
    payload: task.payload,
    assignee: task.assignee,
    priority: task.priority ?? null,
    // Server-owned, in its own namespace: a guard on `task.last_result` can
    // only be satisfied by a value an automation wrote.
    last_result: task.lastResult ?? null,
  };
};
