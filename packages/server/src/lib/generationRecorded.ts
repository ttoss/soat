/**
 * Waits on a keyed generation's record. `claimKeyedGeneration` announces each
 * key once the record it claims is written, so a caller that looked for the
 * row too early waits for it instead of polling. A key may name records in
 * several projects: a waiter re-reads its own project's row when woken.
 */
import createDebug from 'debug';

const log = createDebug('soat:generation-recorded');

const waiters = new Map<string, Set<() => void>>();

/** Wakes every caller waiting on a record under `idempotencyKey`. */
export const announceGenerationRecorded = (args: {
  idempotencyKey: string;
}): void => {
  const pending = waiters.get(args.idempotencyKey);
  if (!pending) return;
  log(
    'announceGenerationRecorded: key=%s waiters=%d',
    args.idempotencyKey,
    pending.size
  );
  waiters.delete(args.idempotencyKey);
  for (const wake of pending) wake();
};

/**
 * Resolves on the next record announced under `idempotencyKey`. Subscribe
 * before looking the row up, so a write between the lookup and the wait is
 * not missed; `cancel` drops the subscription when the wait is abandoned.
 */
export const whenGenerationRecorded = (args: {
  idempotencyKey: string;
}): { recorded: Promise<void>; cancel: () => void } => {
  const key = args.idempotencyKey;
  let wake!: () => void;
  const recorded = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const pending = waiters.get(key) ?? new Set<() => void>();
  pending.add(wake);
  waiters.set(key, pending);
  return {
    recorded,
    cancel: () => {
      pending.delete(wake);
      if (pending.size === 0 && waiters.get(key) === pending) {
        waiters.delete(key);
      }
    },
  };
};
