import { defineMigration } from '@ttoss/postgresdb';

/**
 * `generations.acted_as_principal_type` and `_id`, the principal a turn's
 * latest segment ran its tool calls as. Backfilled from `started_by_*`, the
 * principal a recorded turn's tool calls ran as unless it was resumed.
 */
export const generationActedAs = defineMigration({
  name: '2026-11-10-generation-acted-as',
  description:
    'generations.acted_as_principal_type and _id, backfilled from started_by.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'generations' }))) return true;
    return context.columnExists({
      table: 'generations',
      column: 'acted_as_principal_id',
    });
  },
  up: async (context) => {
    context.say('adding and backfilling generations.acted_as_principal_*');
    const addColumns = `ALTER TABLE generations ADD COLUMN IF NOT EXISTS acted_as_principal_type varchar(255);
ALTER TABLE generations ADD COLUMN IF NOT EXISTS acted_as_principal_id varchar(255);`;
    // One `run`, so the columns never land without their backfill.
    const hasStartedBy = await context.columnExists({
      table: 'generations',
      column: 'started_by_principal_id',
    });
    await context.run({
      sql: hasStartedBy
        ? `${addColumns}
UPDATE generations SET acted_as_principal_type = started_by_principal_type, acted_as_principal_id = started_by_principal_id WHERE started_by_principal_id IS NOT NULL;`
        : addColumns,
    });
  },
});
