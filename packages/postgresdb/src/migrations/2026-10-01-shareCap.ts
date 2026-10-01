import { defineMigration } from '@ttoss/postgresdb';

/**
 * `shares.cap`, the calls each acceptance may make per window. Nullable, no
 * backfill: a share without one is uncapped. Its counters are a new table,
 * which `sync` creates.
 */
export const shareCap = defineMigration({
  name: '2026-10-01-share-cap',
  description: 'shares.cap, the calls each acceptance may make per window.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'shares' }))) return true;
    return context.columnExists({ table: 'shares', column: 'cap' });
  },
  up: async (context) => {
    context.say('adding shares.cap');
    await context.run({
      sql: 'ALTER TABLE shares ADD COLUMN IF NOT EXISTS cap jsonb;',
    });
  },
});
