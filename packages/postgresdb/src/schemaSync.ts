import type { SyncOptions } from '@ttoss/postgresdb';

/**
 * Every schema sync runs with these. `drop: false`: a column a model stops
 * declaring stays until its contract migration drops it, because the previous
 * release still reads it while the next one deploys.
 */
export const SCHEMA_SYNC_OPTIONS = {
  alter: { drop: false },
} satisfies SyncOptions;
