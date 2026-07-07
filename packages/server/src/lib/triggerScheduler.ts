import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { computeNextFireAt } from './triggerValidation';

const log = createDebug('soat:triggers');

const DEFAULT_INTERVAL_MS = 30000;
const BATCH_LIMIT = 20;

// Guards against the same trigger being fired twice within a single process if
// a tick fires again before an in-flight fire finishes.
const inFlight = new Set<number>();

/**
 * Fires a claimed schedule trigger in the background. `prepareFiring` /
 * `runFiringDispatch` are imported lazily (not statically) so this scheduler —
 * started from `server.ts` — stays off the orchestrations↔engine import cycle,
 * matching the inbound `/hooks` router. Failures are logged; a firing that
 * reaches the target records its own outcome.
 */
const fireScheduledTrigger = async (args: {
  triggerPublicId: string;
  internalId: number;
}): Promise<void> => {
  try {
    const { prepareFiring, runFiringDispatch } =
      await import('./triggerDispatch');
    const prepared = await prepareFiring({
      triggerPublicId: args.triggerPublicId,
      source: 'schedule',
      fireInput: null,
    });
    await runFiringDispatch(prepared);
  } catch (error) {
    log(
      'fireDueTriggers: scheduled fire failed trigger=%s %o',
      args.triggerPublicId,
      error
    );
  } finally {
    inFlight.delete(args.internalId);
  }
};

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
export const fireDueTriggers = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();

  let due: InstanceType<typeof db.Trigger>[];
  try {
    due = await db.Trigger.findAll({
      where: {
        type: 'schedule',
        active: true,
        nextFireAt: { [Op.lte]: now },
      },
      order: [['nextFireAt', 'ASC']],
      limit: BATCH_LIMIT,
    });
  } catch (error) {
    log('fireDueTriggers: query failed %o', error);
    return 0;
  }

  let claimedCount = 0;
  for (const trigger of due) {
    const internalId = trigger.id as number;
    if (inFlight.has(internalId)) continue;

    const cron = trigger.cron as string | null;
    const dueAt = trigger.nextFireAt as Date | null;
    if (!cron || !dueAt) continue;

    let nextFireAt: Date | null;
    try {
      nextFireAt = computeNextFireAt(cron, now);
    } catch (error) {
      log(
        'fireDueTriggers: invalid cron trigger=%s %o',
        trigger.publicId,
        error
      );
      continue;
    }

    // Atomic claim: advance nextFireAt only if it still equals the value we
    // read, so a single worker fires each due occurrence.
    const [claimed] = await db.Trigger.update(
      { nextFireAt },
      { where: { id: internalId, nextFireAt: dueAt } }
    );
    if (!claimed) continue;

    inFlight.add(internalId);
    claimedCount += 1;
    void fireScheduledTrigger({
      triggerPublicId: trigger.publicId as string,
      internalId,
    });
  }

  return claimedCount;
};

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the background trigger scheduler loop. Called once from `server.ts` at
 * startup; unit tests never import the server entrypoint, so the timer is not
 * created during tests (they drive {@link fireDueTriggers} directly). Disabled
 * with `SOAT_TRIGGER_SCHEDULER_DISABLED=true`; interval from
 * `SOAT_TRIGGER_SCHEDULER_INTERVAL_MS` (default 30s). The timer is unref'd so it
 * never keeps the process alive, and repeated calls are a no-op.
 */
export const startTriggerScheduler = (args?: { intervalMs?: number }): void => {
  if (timer) return;
  if (process.env.SOAT_TRIGGER_SCHEDULER_DISABLED === 'true') {
    log('startTriggerScheduler: disabled via SOAT_TRIGGER_SCHEDULER_DISABLED');
    return;
  }

  const intervalMs =
    args?.intervalMs ?? Number(process.env.SOAT_TRIGGER_SCHEDULER_INTERVAL_MS);
  const resolvedInterval =
    Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_INTERVAL_MS;

  log('startTriggerScheduler: interval=%dms', resolvedInterval);
  timer = setInterval(() => {
    void fireDueTriggers();
  }, resolvedInterval);
  timer.unref?.();
};

/**
 * Stops the background trigger scheduler loop if it is running. Used for
 * graceful shutdown and to tear the timer down in tests.
 */
export const stopTriggerScheduler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
