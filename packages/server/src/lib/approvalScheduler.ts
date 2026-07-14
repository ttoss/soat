import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { announceApprovalExpired } from './approvals';
import { createScheduler, createSweep } from './scheduler';

const log = createDebug('soat:approvals');

/**
 * Finds pending approval items whose `expiresAt` is due, atomically claims each
 * one (flipping `pending → expired`), and emits `approvals.expired`. Expiry is
 * enforced server-side so a stale proposal can never execute: this sweeper is
 * one of the two directions (the resolution path re-checks `expiresAt` too, per
 * §8 of the PRD).
 *
 * Returns the number of items claimed for expiry this tick.
 */
export const expireDueApprovals = createSweep({
  log,
  name: 'expireDueApprovals',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.ApprovalItem.findAll({
      where: { status: 'pending', expiresAt: { [Op.lte]: now } },
      order: [['expiresAt', 'ASC']],
      limit,
    });
  },
  idOf: (item) => {
    return item.id as number;
  },
  // Atomic claim: pending → expired guarded on the row still being pending and
  // due ensures a single expiry even under overlapping ticks or multiple
  // workers. The winner's handle emits the event.
  claim: async ({ row: item, now }) => {
    const [claimed] = await db.ApprovalItem.update(
      { status: 'expired' },
      {
        where: {
          id: item.id as number,
          status: 'pending',
          expiresAt: { [Op.lte]: now },
        },
      }
    );
    return claimed > 0;
  },
  handle: ({ row: item }) => {
    return announceApprovalExpired({ id: item.publicId as string });
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'APPROVAL_SCHEDULER_INTERVAL_MS',
  sweeps: [expireDueApprovals],
});

/**
 * Starts the approvals expiry sweeper loop. Called once from `server.ts` at
 * startup; unit tests drive {@link expireDueApprovals} directly instead. The
 * timer is unref'd and repeated calls are a no-op.
 */
export const startApprovalScheduler = scheduler.start;

/** Stops the approvals expiry sweeper loop (graceful shutdown / test teardown). */
export const stopApprovalScheduler = scheduler.stop;
