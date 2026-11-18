import createDebug from 'debug';

import { DomainError } from '../errors';
import { findTaskInstance, presentTask } from './tasks';

const log = createDebug('soat:tasks');

/**
 * Every priority a task can hold, highest first; `null` is a task nobody
 * prioritised. The route, the list filter and the spec enum read this list.
 */
export const TASK_PRIORITIES = [
  'very_high',
  'high',
  'medium',
  'low',
  'very_low',
] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const isTaskPriority = (value: unknown): value is TaskPriority => {
  return (
    typeof value === 'string' &&
    (TASK_PRIORITIES as readonly string[]).includes(value)
  );
};

/**
 * A body's `priority`: one of {@link TASK_PRIORITIES}, or `null` when it is
 * `null` or absent. Anything else is refused before a row is written.
 */
export const parseTaskPriority = (value: unknown): TaskPriority | null => {
  if (value === undefined || value === null) return null;
  if (isTaskPriority(value)) return value;
  throw new DomainError(
    'VALIDATION_FAILED',
    `\`priority\` accepts only ${TASK_PRIORITIES.join(', ')} or null`,
    { invalid_fields: ['priority'], allowed: [...TASK_PRIORITIES] }
  );
};

export const setTaskPriority = async (args: {
  id: string;
  priority: TaskPriority | null;
}) => {
  log('setTaskPriority: id=%s priority=%s', args.id, args.priority);
  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  task.priority = args.priority;
  await task.save();
  return presentTask({ task });
};
