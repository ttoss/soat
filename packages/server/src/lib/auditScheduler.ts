import createDebug from 'debug';

import { sweepExpiredAuditEntries } from './auditLog';
import { createScheduler } from './scheduler';

const log = createDebug('soat:audit');

const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * Scheduler-facing wrapper: the retention delete may reject (e.g. the DB is
 * briefly unreachable), but the scheduler dispatches sweeps fire-and-forget, so
 * a rejection would surface as an unhandled promise. Swallow it here and let the
 * next daily tick retry — a missed prune is harmless. Exported for direct
 * testing (it has no HTTP entry point — the scheduler tick is its only caller).
 */
export const runRetentionSweep = async (): Promise<number> => {
  try {
    return await sweepExpiredAuditEntries();
  } catch (error) {
    log('runRetentionSweep: sweep failed %o', error);
    return 0;
  }
};

const scheduler = createScheduler({
  log,
  defaultIntervalMs: DAILY_MS,
  envVar: 'AUDIT_RETENTION_SWEEP_INTERVAL_MS',
  disabledEnvVar: 'AUDIT_RETENTION_SWEEP_DISABLED',
  sweeps: [runRetentionSweep],
});

/**
 * Starts the daily audit-retention sweep. Called once from `server.ts`; unit
 * tests never import the server entrypoint, so the timer is not created during
 * tests (they call {@link sweepExpiredAuditEntries} directly).
 */
export const startAuditRetentionScheduler = scheduler.start;

/** Stops the retention sweep timer (graceful shutdown / test teardown). */
export const stopAuditRetentionScheduler = scheduler.stop;
