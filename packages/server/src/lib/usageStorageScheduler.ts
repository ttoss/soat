import createDebug from 'debug';

import { createScheduler } from './scheduler';
import { runStorageSnapshot } from './usageStorage';

const log = createDebug('soat:usage');

const DAILY_MS = 24 * 60 * 60 * 1000;

const scheduler = createScheduler({
  log,
  defaultIntervalMs: DAILY_MS,
  envVar: 'USAGE_STORAGE_SNAPSHOT_INTERVAL_MS',
  disabledEnvVar: 'USAGE_STORAGE_SNAPSHOT_DISABLED',
  sweeps: [runStorageSnapshot],
});

/**
 * Starts the daily storage-metering snapshot. Called once from `server.ts`;
 * unit tests never import the server entrypoint, so the timer is not created
 * during tests (they call {@link runStorageSnapshot} / `snapshotProjectStorage`
 * directly).
 */
export const startUsageStorageScheduler = scheduler.start;

/** Stops the snapshot timer (graceful shutdown / test teardown). */
export const stopUsageStorageScheduler = scheduler.stop;
