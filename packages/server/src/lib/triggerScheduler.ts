import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { createScheduler, createSweep } from './scheduler';
import { computeNextFireAt } from './triggerValidation';

const log = createDebug('soat:triggers');

/**
 * Finds active schedule triggers whose fire is due (`type='schedule'`,
 * `active=true`, `nextFireAt <= now`), atomically claims each one by advancing
 * `nextFireAt` to the next occurrence computed from **now**, and fires it.
 *
 * The claim is a guarded conditional `UPDATE` (advance only if `nextFireAt` is
 * still the value we read), so overlapping ticks or multiple server instances
 * fire each due trigger exactly once. Recomputing from `now` (not from the
 * missed due time) is the misfire-coalescing rule: occurrences missed while the
 * server was down collapse into at most one catch-up firing, then the normal
 * cadence resumes.
 *
 * Returns the number of triggers claimed for firing this tick.
 */
export const fireDueTriggers = createSweep({
  log,
  name: 'fireDueTriggers',
  inFlight: new Set<number>(),
  findDue: ({ now, limit }) => {
    return db.Trigger.findAll({
      where: {
        type: 'schedule',
        active: true,
        nextFireAt: { [Op.lte]: now },
      },
      order: [['nextFireAt', 'ASC']],
      limit,
    });
  },
  idOf: (trigger) => {
    return trigger.id as number;
  },
  claim: async ({ row: trigger, now }) => {
    const cron = trigger.cron as string | null;
    const dueAt = trigger.nextFireAt as Date | null;
    if (!cron || !dueAt) return false;

    let nextFireAt: Date | null;
    try {
      nextFireAt = computeNextFireAt(cron, now);
    } catch (error) {
      log(
        'fireDueTriggers: invalid cron trigger=%s %o',
        trigger.publicId,
        error
      );
      return false;
    }

    // Atomic claim: advance nextFireAt only if it still equals the value we
    // read, so a single worker fires each due occurrence.
    const [claimed] = await db.Trigger.update(
      { nextFireAt },
      { where: { id: trigger.id as number, nextFireAt: dueAt } }
    );
    return claimed > 0;
  },
  // `prepareFiring` / `runFiringDispatch` are imported lazily (not statically)
  // so this scheduler — started from `server.ts` — stays off the
  // orchestrations↔engine import cycle, matching the inbound `/hooks` router.
  // A static import here front-loads triggerDispatch's orchestration graph at
  // app init and breaks that cycle (every orchestration-run POST 500s).
  handle: async ({ row: trigger }) => {
    const { prepareFiring, runFiringDispatch } =
      await import('./triggerDispatch');
    const prepared = await prepareFiring({
      triggerPublicId: trigger.publicId as string,
      source: 'schedule',
      fireInput: null,
    });
    await runFiringDispatch(prepared);
  },
});

const scheduler = createScheduler({
  log,
  defaultIntervalMs: 30000,
  envVar: 'SOAT_TRIGGER_SCHEDULER_INTERVAL_MS',
  disabledEnvVar: 'SOAT_TRIGGER_SCHEDULER_DISABLED',
  sweeps: [fireDueTriggers],
});

/**
 * Starts the background trigger scheduler loop. Called once from `server.ts` at
 * startup; unit tests never import the server entrypoint, so the timer is not
 * created during tests (they drive {@link fireDueTriggers} directly). Disabled
 * with `SOAT_TRIGGER_SCHEDULER_DISABLED=true`; interval from
 * `SOAT_TRIGGER_SCHEDULER_INTERVAL_MS` (default 30s). The timer is unref'd so it
 * never keeps the process alive, and repeated calls are a no-op.
 */
export const startTriggerScheduler = scheduler.start;

/**
 * Stops the background trigger scheduler loop if it is running. Used for
 * graceful shutdown and to tear the timer down in tests.
 */
export const stopTriggerScheduler = scheduler.stop;
