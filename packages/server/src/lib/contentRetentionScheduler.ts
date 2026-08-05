import createDebug from 'debug';

import { sweepExpiredTraceContent } from './contentRetention';
import { createScheduler } from './scheduler';

const log = createDebug('soat:content-retention');

const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * Scheduler-facing wrapper: a purge may reject (e.g. the DB is briefly
 * unreachable, or a storage delete throws), but the scheduler dispatches sweeps
 * fire-and-forget, so a rejection would surface as an unhandled promise.
 * Swallow it here and let the next daily tick retry — every purge is idempotent
 * and the due-set query is recomputed each time, so a missed or partial sweep
 * simply resumes where it stopped. Exported for direct testing (the scheduler
 * tick is its only other caller).
 */
export const runContentRetentionSweep = async (): Promise<number> => {
  try {
    return await sweepExpiredTraceContent();
  } catch (error) {
    log('runContentRetentionSweep: sweep failed %o', error);
    return 0;
  }
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: DAILY_MS,
  envVar: 'CONTENT_RETENTION_SWEEP_INTERVAL_MS',
  disabledEnvVar: 'CONTENT_RETENTION_SWEEP_DISABLED',
  sweeps: [runContentRetentionSweep],
});

/**
 * Starts the daily trace-content retention sweep. Called once from `server.ts`;
 * unit tests never import the server entrypoint, so the timer is not created
 * during tests (they call {@link sweepExpiredTraceContent} directly with an
 * injected `now`).
 */
export const startContentRetentionScheduler = scheduler.start;

/** Stops the retention sweep timer (graceful shutdown / test teardown). */
export const stopContentRetentionScheduler = scheduler.stop;
