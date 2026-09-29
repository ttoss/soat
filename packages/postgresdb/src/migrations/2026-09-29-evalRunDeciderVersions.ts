import { defineMigration } from '@ttoss/postgresdb';

/**
 * `eval_runs.decider_versions` pins, per decider scorer, the decider version a
 * run grades under, so a decider edited mid-run cannot regrade half of it.
 *
 * `sync` never alters an existing table, so the column is a migration.
 * Nullable with no default: a run without a decider scorer pins nothing.
 */
export const evalRunDeciderVersions = defineMigration({
  name: '2026-09-29-eval-run-decider-versions',
  description:
    'eval_runs.decider_versions pins the decider version each decider scorer grades under.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return context.columnExists({
      table: 'eval_runs',
      column: 'decider_versions',
    });
  },
  up: async (context) => {
    context.say('adding eval_runs.decider_versions');
    await context.addColumnIfMissing({
      table: 'eval_runs',
      column: 'decider_versions',
      type: 'jsonb',
    });
  },
});
