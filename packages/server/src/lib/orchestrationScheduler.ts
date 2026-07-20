import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { newLeaseExpiry } from './orchestrationLease';
import { enqueueRunTask } from './orchestrationQueue';
import { kickWorker } from './orchestrationWorker';
import { createScheduler, createSweep } from './scheduler';

const log = createDebug('soat:orchestrations');

/**
 * Finds sleeping runs whose wake is due (`status = 'sleeping'` and
 * `wakeAt <= now`), atomically claims each one (transitioning it to `running`),
 * and enqueues a `wake` task for a worker to drive. Because the due set lives in
 * the database, a run parked before a restart is picked up on the next tick
 * after the process comes back — long delays survive restarts. The atomic claim
 * guarantees exactly one `wake` task per due run even across overlapping ticks
 * or multiple workers.
 *
 * Returns the number of runs claimed for waking this tick.
 */
export const wakeDueRuns = createSweep({
  log,
  name: 'wakeDueRuns',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.OrchestrationRun.findAll({
      where: { status: 'sleeping', wakeAt: { [Op.lte]: now } },
      order: [['wakeAt', 'ASC']],
      limit,
    });
  },
  idOf: (run) => {
    return run.id as number;
  },
  // Atomic claim: flipping sleeping → running guarded on wakeAt still being
  // set ensures a single wake even with overlapping ticks or multiple workers.
  // The woken run re-enters `running`, so it acquires a fresh lease.
  claim: async ({ row: run }) => {
    const [claimed] = await db.OrchestrationRun.update(
      { status: 'running', wakeAt: null, leaseExpiresAt: newLeaseExpiry() },
      { where: { id: run.id as number, wakeAt: { [Op.ne]: null } } }
    );
    return claimed > 0;
  },
  handle: async ({ row: run }) => {
    await enqueueRunTask({ runId: run.id as number, kind: 'wake' });
    kickWorker();
  },
});

/**
 * Finds orphaned runs — `running` runs whose lease has expired because their
 * driver crashed or was redeployed mid-execution and stopped refreshing it —
 * atomically claims each one (by extending the lease), and enqueues a
 * `continue` task so a worker re-drives it from its last checkpoint. A healthy
 * run refreshes its lease each round, so it is never reclaimed while it is
 * making progress. Extending the lease under the atomic claim guarantees exactly
 * one `continue` task per orphan even across overlapping ticks or workers.
 *
 * Returns the number of runs claimed for re-driving this tick.
 */
export const reapOrphanedRuns = createSweep({
  log,
  name: 'reapOrphanedRuns',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.OrchestrationRun.findAll({
      where: { status: 'running', leaseExpiresAt: { [Op.lt]: now } },
      order: [['leaseExpiresAt', 'ASC']],
      limit,
    });
  },
  idOf: (run) => {
    return run.id as number;
  },
  // Atomic claim: extend the lease guarded on it still being expired so a
  // single reaper (across overlapping ticks or multiple workers) reclaims it.
  claim: async ({ row: run, now }) => {
    const [claimed] = await db.OrchestrationRun.update(
      { leaseExpiresAt: newLeaseExpiry({ now: now.getTime() }) },
      {
        where: {
          id: run.id as number,
          status: 'running',
          leaseExpiresAt: { [Op.lt]: now },
        },
      }
    );
    return claimed > 0;
  },
  handle: async ({ row: run }) => {
    await enqueueRunTask({ runId: run.id as number, kind: 'continue' });
    kickWorker();
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 5000,
  envVar: 'ORCHESTRATION_SCHEDULER_INTERVAL_MS',
  sweeps: [wakeDueRuns, reapOrphanedRuns],
});

/**
 * Starts the background scheduler loop. Called once from `server.ts` at startup;
 * unit tests never import the server entrypoint, so the timer is not created
 * during tests (they drive {@link wakeDueRuns} directly, or use fake timers to
 * exercise the interval). The timer is unref'd so it never keeps the process
 * alive on its own, and repeated calls are a no-op.
 */
export const startOrchestrationScheduler = scheduler.start;

/**
 * Stops the background scheduler loop if it is running. Used for graceful
 * shutdown and to tear the timer down in tests.
 */
export const stopOrchestrationScheduler = scheduler.stop;
