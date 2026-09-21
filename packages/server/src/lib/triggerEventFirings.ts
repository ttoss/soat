import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { runWithCausationChain } from './eventCausation';
import { createSweep } from './scheduler';
import { isUniqueViolation } from './uniqueViolation';

const log = createDebug('soat:triggers');

/**
 * Durability for event-trigger firings.
 *
 * A schedule trigger is recovered from its own row: `next_fire_at` is still due
 * on the next tick, whatever happened to the process that should have fired it.
 * An event trigger had no such row — the event lived on an in-process bus, and
 * a restart between the emit and the dispatch lost the firing with nothing left
 * to show it was ever owed.
 *
 * So the firing row is written first, before the trigger's credentials are
 * resolved and before its target is touched. From that point the firing is
 * owned by the database: whichever process finds the lease lapsed runs it. The
 * cost is the usual one — at-least-once rather than exactly-once, since a
 * firing interrupted mid-dispatch may have already started its target — which
 * is the same guarantee the webhook outbox gives, and the same reason targets
 * are expected to be idempotent.
 */

/**
 * How long a firing is claimed for.
 *
 * It bounds how long an interrupted firing stays stranded, so it trades
 * duplicate dispatches (too short: a slow but live dispatch is reclaimed)
 * against slow recovery (too long). Sixty seconds matches the webhook outbox's
 * lease, and a dispatch that legitimately runs longer than that is one that
 * waits on a run rather than one that holds it.
 */
export const EVENT_FIRING_LEASE_MS = 60_000;

/**
 * How many times one firing may be started.
 *
 * Only an *interrupted* firing is ever retried — a dispatch that reached its
 * target and failed is recorded terminally and never swept. So this bounds the
 * one case the lease cannot distinguish from a slow dispatch: a firing whose
 * work kills the process every time it is attempted.
 */
export const MAX_EVENT_FIRING_ATTEMPTS = 3;

type FiringRow = InstanceType<(typeof db)['TriggerFiring']>;

/**
 * One firing per (event, trigger).
 *
 * The event id is what makes it an identity rather than a guess: an event's
 * type, resource and millisecond stamp are shared by every emission of that
 * type on that resource in that millisecond.
 */
export const eventFiringIdempotencyKey = (args: {
  eventId: string;
  triggerPublicId: string;
}): string => {
  return `${args.eventId}:${args.triggerPublicId}`;
};

/**
 * Writes the firing row for one matched (event, trigger) pair, claimed by the
 * caller so it can dispatch immediately.
 *
 * `null` means another process already holds this firing — the unique key
 * turned a redelivered event into a no-op rather than a second run of the
 * target. That is a skip, not a failure: the row exists, and whoever wrote it
 * (or the sweep) will run it.
 */
export const reserveEventFiring = async (args: {
  triggerDbId: number;
  triggerPublicId: string;
  projectId: number;
  eventId: string;
  input: Record<string, unknown>;
  /** The chain the dispatch runs under, including this trigger. */
  causationChain: readonly string[];
  now?: Date;
}): Promise<FiringRow | null> => {
  const now = args.now ?? new Date();
  const idempotencyKey = eventFiringIdempotencyKey({
    eventId: args.eventId,
    triggerPublicId: args.triggerPublicId,
  });

  try {
    const firing = await db.TriggerFiring.create({
      triggerId: args.triggerDbId,
      projectId: args.projectId,
      source: 'event',
      status: 'pending',
      input: args.input,
      result: null,
      error: null,
      idempotencyKey,
      causationChain: [...args.causationChain],
      // The caller dispatches as soon as this returns, so the first attempt is
      // this one; a lease taken now keeps a concurrent sweep off the row.
      attempts: 1,
      leaseExpiresAt: new Date(now.getTime() + EVENT_FIRING_LEASE_MS),
      startedAt: null,
      completedAt: null,
    });

    log(
      'reserveEventFiring: firing=%s trigger=%s key=%s',
      firing.publicId,
      args.triggerPublicId,
      idempotencyKey
    );

    return firing;
  } catch (error) {
    /* istanbul ignore next -- any other insert failure is a database fault
       the caller's own error handling owns, not a duplicate to fold into. */
    if (!isUniqueViolation(error)) throw error;

    log('reserveEventFiring: already enqueued key=%s', idempotencyKey);
    return null;
  }
};

/**
 * A firing nobody is running: claimed at some point, never finished, and its
 * lease has lapsed.
 *
 * `running` is included because that is what an interrupted dispatch looks
 * like — `runFiringDispatch` writes a terminal status in its own `catch`, so a
 * firing that is still `running` with no live lease is one whose process went
 * away rather than one that failed.
 *
 * Scoped to `event`: every other source either recovers from its own row (a
 * schedule's `next_fire_at`) or has a caller that was told what happened (a
 * manual or webhook fire).
 */
const duePredicate = (args: { now: Date }) => {
  return {
    source: 'event',
    status: ['pending', 'running'],
    attempts: { [Op.lt]: MAX_EVENT_FIRING_ATTEMPTS },
    leaseExpiresAt: { [Op.lt]: args.now },
  };
};

/**
 * Runs a reserved firing under the chain it was reserved with.
 *
 * The chain travels in `AsyncLocalStorage`, which the sweep runs outside of, so
 * it is read back off the row. Without it a redelivered firing would dispatch
 * with an empty chain and the loop guard would not refuse the cycle it refused
 * the first time.
 */
export const runEventFiring = async (args: {
  firing: FiringRow;
}): Promise<void> => {
  // Imported lazily so this module stays off the orchestrations↔engine import
  // cycle, matching `triggerScheduler.ts`.
  const { runReservedFiring } = await import('./triggerDispatch');

  await runWithCausationChain({
    chain: (args.firing.causationChain as string[] | null) ?? [],
    fn: () => {
      return runReservedFiring({ firing: args.firing });
    },
  });
};

/**
 * Redelivers event firings whose process went away.
 *
 * This is what makes an event trigger durable: a firing whose dispatch was
 * interrupted by a restart keeps its row and its lease, and is reclaimed here
 * once that lease expires. Nothing depends on the process that matched the
 * event still being alive.
 */
export const sweepDueEventFirings = createSweep<FiringRow>({
  log,
  name: 'sweepDueEventFirings',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.TriggerFiring.findAll({
      where: duePredicate({ now }),
      order: [['createdAt', 'ASC']],
      limit,
    });
  },
  idOf: (firing) => {
    return firing.id as number;
  },
  // Atomic claim: taking the lease under the same predicate that selected the
  // row means overlapping ticks, or several server instances, start each
  // attempt once. Must stay a conditional UPDATE — never read-then-write.
  claim: async ({ row, now }) => {
    const [claimed] = await db.TriggerFiring.update(
      {
        leaseExpiresAt: new Date(now.getTime() + EVENT_FIRING_LEASE_MS),
        attempts: (row.attempts as number) + 1,
      },
      { where: { id: row.id as number, ...duePredicate({ now }) } }
    );
    return claimed > 0;
  },
  handle: async ({ row }) => {
    log('sweepDueEventFirings: redelivering firing=%s', row.publicId);
    await runEventFiring({ firing: row });
  },
});

/**
 * Closes a firing the sweep has given up on, so it does not sit `pending`
 * forever with nothing coming for it.
 *
 * Separate from the sweep because it is the opposite decision: the sweep finds
 * firings worth another attempt, and this finds the ones that have had all of
 * theirs.
 */
export const failExhaustedEventFirings = createSweep<FiringRow>({
  log,
  name: 'failExhaustedEventFirings',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.TriggerFiring.findAll({
      where: {
        source: 'event',
        status: ['pending', 'running'],
        attempts: { [Op.gte]: MAX_EVENT_FIRING_ATTEMPTS },
        leaseExpiresAt: { [Op.lt]: now },
      },
      limit,
    });
  },
  idOf: (firing) => {
    return firing.id as number;
  },
  claim: async ({ row, now }) => {
    const [claimed] = await db.TriggerFiring.update(
      {
        status: 'failed',
        completedAt: now,
        leaseExpiresAt: null,
        error: {
          code: 'TRIGGER_FIRING_ABANDONED',
          message: `Firing was interrupted ${MAX_EVENT_FIRING_ATTEMPTS} times without reaching a result.`,
          meta: { attempts: row.attempts },
        },
      },
      {
        where: {
          id: row.id as number,
          status: ['pending', 'running'],
          attempts: { [Op.gte]: MAX_EVENT_FIRING_ATTEMPTS },
          leaseExpiresAt: { [Op.lt]: now },
        },
      }
    );
    return claimed > 0;
  },
  handle: async ({ row }) => {
    log('failExhaustedEventFirings: abandoned firing=%s', row.publicId);
    return Promise.resolve();
  },
});
