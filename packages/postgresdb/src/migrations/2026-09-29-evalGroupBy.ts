import { defineMigration } from '@ttoss/postgresdb';

/**
 * `evals.group_by` names the item `metadata` key a run rolls its scores up by.
 *
 * `sync` never alters an existing table, so the column is a migration.
 * Nullable with no default: an eval without it reports no grouping.
 */
export const evalGroupBy = defineMigration({
  name: '2026-09-29-eval-group-by',
  description:
    'evals.group_by names the item metadata key a run aggregates scores by.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'evals' }))) return true;
    return context.columnExists({ table: 'evals', column: 'group_by' });
  },
  up: async (context) => {
    context.say('adding evals.group_by');
    await context.addColumnIfMissing({
      table: 'evals',
      column: 'group_by',
      type: 'varchar(255)',
    });
  },
});
