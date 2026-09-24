/**
 * At-most-once starts for the requests that spend model tokens: an orchestration
 * run and an agent generation. A key is claimed by the row the request writes
 * and stays claimed for as long as that row exists — a window that expired
 * would put back exactly the doubt the key removes.
 */
import { DomainError } from '../errors';
import { isUniqueViolation } from './uniqueViolation';

/**
 * What `create` wrote, or the replay of what the key already names.
 *
 * The insert is attempted even after `replay` finds nothing, because only the
 * unique index settles the race the key exists for: a retry provoked by a
 * timeout arrives while the original insert is still in flight.
 */
export const claimIdempotencyKey = async <Created, Replayed>(args: {
  replay: () => Promise<Replayed | null>;
  create: () => Promise<Created>;
}): Promise<{ created: Created } | { replayed: Replayed }> => {
  const replayed = await args.replay();
  if (replayed) return { replayed };

  try {
    return { created: await args.create() };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await args.replay();
    if (!raced) throw error;
    return { replayed: raced };
  }
};

/**
 * A key reused for a different request. Replaying what the key names under a
 * body the caller did not send would hand back work that does not do what they
 * just asked for, which is worse than refusing.
 */
export const idempotencyKeyReused = (args: {
  idempotencyKey: string;
  claimedBy: 'run' | 'generation';
}): DomainError => {
  return new DomainError(
    'IDEMPOTENCY_KEY_REUSED',
    `Idempotency key '${args.idempotencyKey}' is already claimed by a ${args.claimedBy} started from a different request.`,
    { idempotency_key: args.idempotencyKey }
  );
};
