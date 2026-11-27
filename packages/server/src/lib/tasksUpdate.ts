import createDebug from 'debug';

import { DomainError } from '../errors';
import { findTaskInstance, presentTask } from './tasks';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
import { validatePayload } from './workflowsValidation';

const log = createDebug('soat:tasks');

/**
 * The payload a write leaves: shallow-merged over the stored one, so a caller
 * setting one key keeps the others, `payload_writes` included, and validated
 * against the schema the task entered on, so a schema tightened later never
 * makes an in-flight task unwritable. The one rule for `PATCH` and a
 * transition's `payload`.
 */
export const mergeTaskPayload = (args: {
  stored: Record<string, unknown> | null;
  patch: Record<string, unknown>;
  payloadSchema: unknown;
}): Record<string, unknown> => {
  const merged = {
    ...(args.stored ?? {}),
    ...args.patch,
  };
  validatePayload({ payloadSchema: args.payloadSchema, payload: merged });
  return merged;
};

export const updateTask = async (args: {
  id: string;
  title?: string;
  payload?: Record<string, unknown>;
  assignee?: string | null;
  /** Replaces the stored bag; `null` clears it. */
  metadata?: Record<string, unknown> | null;
}) => {
  log('updateTask: id=%s', args.id);

  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }

  if (args.payload !== undefined) {
    const { payloadSchema } = await resolveTaskDefinition({
      task,
      workflow: task.workflow!,
    });
    task.payload = mergeTaskPayload({
      stored: task.payload as Record<string, unknown> | null,
      patch: args.payload,
      payloadSchema,
    });
  }
  if (args.title !== undefined) task.title = args.title;
  if (args.assignee !== undefined) task.assignee = args.assignee;
  if (args.metadata !== undefined) task.metadata = args.metadata;

  await task.save();

  const updated = await findTaskInstance({ id: args.id });
  return presentTask({ task: updated! });
};
