import createDebug from 'debug';

import { createScheduler } from './scheduler';
import { flushRequestCounters } from './usageRequests';

const log = createDebug('soat:usage');

// Flush aggregated request counts once a minute by default. Configurable via
// USAGE_REQUEST_FLUSH_INTERVAL_MS; the value is a freshness-vs-row-volume
// trade-off, so it is left tunable rather than hard-coded.
const FLUSH_MS = 60 * 1000;

const scheduler = createScheduler({
  log,
  defaultIntervalMs: FLUSH_MS,
  envVar: 'USAGE_REQUEST_FLUSH_INTERVAL_MS',
  disabledEnvVar: 'USAGE_REQUEST_METERING_DISABLED',
  sweeps: [flushRequestCounters],
});

/**
 * Starts the periodic API-request counter flush. Called once from `server.ts`;
 * unit tests never import the server entrypoint, so the timer is not created
 * during tests (they call {@link flushRequestCounters} directly). The last,
 * still-open window is lost on an unclean shutdown — a bounded undercount
 * accepted for v1, symmetric across projects.
 */
export const startUsageRequestScheduler = scheduler.start;

/** Stops the flush timer (graceful shutdown / test teardown). */
export const stopUsageRequestScheduler = scheduler.stop;
