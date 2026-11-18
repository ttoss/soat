import createDebug from 'debug';
import { db } from 'src/db';

import { idempotencyKeyReused } from './idempotencyClaim';
import { stableDigest } from './stableDigest';

const log = createDebug('soat:tasks');

/** The key a create request carries and the digest of what it asked for. */
export type TaskCreateIdempotency = { key: string; digest: string };

/**
 * Every field that shapes the task the create writes, each normalised the way
 * `createTask` stores it, so a retry that omits a field it first sent empty
 * still names the same request. `project_id` is not among them: it selects the
 * scope the key is looked up in.
 */
export const createTaskRequestDigest = (args: {
  workflowId: string;
  title: string;
  payload?: Record<string, unknown> | null;
  assignee?: string | null;
  state?: string | null;
  toolContext?: Record<string, string> | null;
  metadata?: Record<string, unknown>;
}): string => {
  return stableDigest({
    workflow: args.workflowId,
    title: args.title,
    payload: args.payload ?? {},
    assignee: args.assignee ?? null,
    state: args.state ?? null,
    context: args.toolContext ?? null,
    metadata: args.metadata ?? null,
  });
};

/** The columns a create writes for its claim; both null when it sent no key. */
export const taskIdempotencyColumns = (claim?: TaskCreateIdempotency) => {
  return {
    idempotencyKey: claim?.key ?? null,
    idempotencyDigest: claim?.digest ?? null,
  };
};

/**
 * The public id of the task the key already created in this project, or
 * `null` when the key is unclaimed. A different request under the key throws
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export const findCreatedTask = async (args: {
  projectId: number;
  claim: TaskCreateIdempotency;
}): Promise<string | null> => {
  const task = await db.Task.findOne({
    where: { projectId: args.projectId, idempotencyKey: args.claim.key },
    attributes: ['publicId', 'idempotencyDigest'],
  });
  if (!task) return null;
  if (task.idempotencyDigest !== args.claim.digest) {
    log('findCreatedTask: key=%s reused', args.claim.key);
    throw idempotencyKeyReused({
      idempotencyKey: args.claim.key,
      claimedBy: 'task',
    });
  }
  return task.publicId;
};
