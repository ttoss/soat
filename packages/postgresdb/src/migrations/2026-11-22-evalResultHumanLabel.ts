import { defineMigration } from '@ttoss/postgresdb';

/**
 * A user's or API key's label on an eval result. Nothing to fill: a result nobody
 * labeled has no label.
 */
export const evalResultHumanLabel = defineMigration({
  name: '2026-11-22-eval-result-human-label',
  description: 'eval_results human label columns.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_results' }))) return true;
    return context.columnExists({
      table: 'eval_results',
      column: 'labeled_at',
    });
  },
  up: async (context) => {
    context.say('adding eval_results human label columns');
    await context.run({
      sql: `ALTER TABLE eval_results
        ADD COLUMN IF NOT EXISTS human_passed boolean,
        ADD COLUMN IF NOT EXISTS label_note text,
        ADD COLUMN IF NOT EXISTS labeled_by_principal_type varchar(16),
        ADD COLUMN IF NOT EXISTS labeled_by_principal_id varchar(32),
        ADD COLUMN IF NOT EXISTS labeled_at timestamptz;`,
    });
  },
});
