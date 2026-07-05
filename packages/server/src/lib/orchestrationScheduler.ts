import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { redriveRun, wakeRun } from './orchestrationEngine';
import { newLeaseExpiry } from './orchestrationLease';

const log = createDebug('soat:orchestrations');

const DEFAULT_INTERVAL_MS = 5000;
const BATCH_LIMIT = 20;

// Guards against the same run being woken or reaped twice within a single
// process if a tick fires again before an in-flight wake/redrive finishes.
const inFlight = new Set<number>();

/**
 * Finds sleeping runs whose wake is due (`status = 'sleeping'` and
 * `wakeAt <= now`), atomically claims each one (transitioning it to `running`),
 * and wakes it. Because the due set lives in the database, a run parked before a
 * restart is picked up on the next tick after the process comes back — long
 * delays survive restarts.
 *
 * Returns the number of runs claimed for waking this tick.
 */
export const wakeDueRuns = async (args?: { now?: Date }): Promise<number> => {
  const now = args?.now ?? new Date();

  let due: InstanceType<typeof db.OrchestrationRun>[];
  try {
    due = await db.OrchestrationRun.findAll({
      where: { status: 'sleeping', wakeAt: { [Op.lte]: now } },
      order: [['wakeAt', 'ASC']],
      limit: BATCH_LIMIT,
    });
  } catch (error) {
    log('wakeDueRuns: query failed %o', error);
    return 0;
  }

  let claimedCount = 0;
  for (const run of due) {
    const runId = run.id as number;
    if (inFlight.has(runId)) continue;

    // Atomic claim: flipping sleeping → running guarded on wakeAt still being
    // set ensures a single wake even with overlapping ticks or multiple workers.
    // The woken run re-enters `running`, so it acquires a fresh lease.
    const [claimed] = await db.OrchestrationRun.update(
      { status: 'running', wakeAt: null, leaseExpiresAt: newLeaseExpiry() },
      { where: { id: runId, wakeAt: { [Op.ne]: null } } }
    );
    if (!claimed) continue;

    inFlight.add(runId);
    claimedCount += 1;
    void wakeRun({ run })
      .catch((error: unknown) => {
        log('wakeDueRuns: wake failed runId=%s %o', runId, error);
      })
      .finally(() => {
        inFlight.delete(runId);
      });
  }

  return claimedCount;
};

/**
 * Finds orphaned runs — `running` runs whose lease has expired because their
 * driver crashed or was redeployed mid-execution and stopped refreshing it —
 * atomically claims each one (by extending the lease), and re-drives it from its
 * last checkpoint. A healthy run refreshes its lease each round, so it is never
 * reclaimed while it is making progress.
 *
 * Returns the number of runs claimed for re-driving this tick.
 */
export const reapOrphanedRuns = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();

  let orphaned: InstanceType<typeof db.OrchestrationRun>[];
  try {
    orphaned = await db.OrchestrationRun.findAll({
      where: { status: 'running', leaseExpiresAt: { [Op.lt]: now } },
      order: [['leaseExpiresAt', 'ASC']],
      limit: BATCH_LIMIT,
    });
  } catch (error) {
    log('reapOrphanedRuns: query failed %o', error);
    return 0;
  }

  let claimedCount = 0;
  for (const run of orphaned) {
    const runId = run.id as number;
    if (inFlight.has(runId)) continue;

    // Atomic claim: extend the lease guarded on it still being expired so a
    // single reaper (across overlapping ticks or multiple workers) reclaims it.
    const [claimed] = await db.OrchestrationRun.update(
      { leaseExpiresAt: newLeaseExpiry({ now: now.getTime() }) },
      {
        where: {
          id: runId,
          status: 'running',
          leaseExpiresAt: { [Op.lt]: now },
        },
      }
    );
    if (!claimed) continue;

    inFlight.add(runId);
    claimedCount += 1;
    void redriveRun({ run })
      .catch((error: unknown) => {
        log('reapOrphanedRuns: redrive failed runId=%s %o', runId, error);
      })
      .finally(() => {
        inFlight.delete(runId);
      });
  }

  return claimedCount;
};

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the background scheduler loop. Called once from `server.ts` at startup;
 * unit tests never import the server entrypoint, so the timer is not created
 * during tests (they drive {@link wakeDueRuns} directly, or use fake timers to
 * exercise the interval). The timer is unref'd so it never keeps the process
 * alive on its own, and repeated calls are a no-op.
 */
export const startOrchestrationScheduler = (args?: {
  intervalMs?: number;
}): void => {
  if (timer) return;

  const intervalMs =
    args?.intervalMs ?? Number(process.env.ORCHESTRATION_SCHEDULER_INTERVAL_MS);
  const resolvedInterval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_INTERVAL_MS;

  log('startOrchestrationScheduler: interval=%dms', resolvedInterval);
  timer = setInterval(() => {
    void wakeDueRuns();
    void reapOrphanedRuns();
  }, resolvedInterval);
  timer.unref?.();
};

/**
 * Stops the background scheduler loop if it is running. Used for graceful
 * shutdown and to tear the timer down in tests.
 */
export const stopOrchestrationScheduler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
