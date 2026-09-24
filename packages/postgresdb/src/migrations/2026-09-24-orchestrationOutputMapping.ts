import { defineMigration } from '@ttoss/postgresdb';

/**
 * `orchestrations.output_mapping` declares the shape of a run's `output`, so a
 * consumer reads fields the orchestration owns rather than terminal node ids.
 *
 * `sync` creates missing tables and never alters an existing one, so the column
 * is a migration. Nullable with no default: an orchestration without a mapping
 * keys `output` by terminal node id.
 */
export const orchestrationOutputMapping = defineMigration({
  name: '2026-09-24-orchestration-output-mapping',
  description:
    'orchestrations.output_mapping declares the shape of a run output, independent of terminal node ids.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'orchestrations' }))) return true;
    return context.columnExists({
      table: 'orchestrations',
      column: 'output_mapping',
    });
  },
  up: async (context) => {
    context.say('adding orchestrations.output_mapping');
    await context.addColumnIfMissing({
      table: 'orchestrations',
      column: 'output_mapping',
      type: 'jsonb',
    });
  },
});
