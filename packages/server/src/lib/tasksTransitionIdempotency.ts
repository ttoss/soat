import createDebug from 'debug';
import { db } from 'src/db';

import type { Transaction } from './dbTransaction';
import { idempotencyKeyReused } from './idempotencyClaim';
import { stableDigest } from './stableDigest';

const log = createDebug('soat:tasks');

/** The key a transition request carries and the digest of what it asked for. */
export type TransitionIdempotency = { key: string; digest: string };

/**
 * `toolContext` is left out when absent: omitting it keeps the stored bag,
 * which is a different request from sending `null` or `{}`.
 */
export const transitionRequestDigest = (args: {
  transition: string;
  note?: string | null;
  toolContext?: Record<string, string> | null;
  payload?: Record<string, unknown>;
}): string => {
  return stableDigest({
    transition: args.transition,
    note: args.note ?? null,
    ...(args.payload === undefined ? {} : { payload: args.payload }),
    ...(args.toolContext === undefined ? {} : { context: args.toolContext }),
  });
};

const assertSameRequest = (args: {
  claim: TransitionIdempotency;
  storedDigest: string | null;
}): void => {
  if (args.storedDigest === args.claim.digest) return;
  log('findTransitionClaim: key=%s reused', args.claim.key);
  throw idempotencyKeyReused({
    idempotencyKey: args.claim.key,
    claimedBy: 'transition',
  });
};

/**
 * Whether the key already names a move on this task: the history row an
 * applied move wrote, or the approval item a parked one wrote instead. A
 * different request under the key throws `IDEMPOTENCY_KEY_REUSED`.
 */
export const findTransitionClaim = async (args: {
  taskId: number;
  taskPublicId: string;
  claim: TransitionIdempotency;
  transaction?: Transaction;
}): Promise<boolean> => {
  const applied = await db.TaskTransition.findOne({
    where: { taskId: args.taskId, idempotencyKey: args.claim.key },
    attributes: ['idempotencyDigest'],
    transaction: args.transaction,
  });
  if (applied) {
    assertSameRequest({
      claim: args.claim,
      storedDigest: applied.idempotencyDigest,
    });
    return true;
  }
  const parked = await db.ApprovalItem.findOne({
    where: { taskId: args.taskPublicId, idempotencyKey: args.claim.key },
    attributes: ['idempotencyDigest'],
    transaction: args.transaction,
  });
  if (!parked) return false;
  assertSameRequest({
    claim: args.claim,
    storedDigest: parked.idempotencyDigest,
  });
  return true;
};
