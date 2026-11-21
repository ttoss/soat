import { defineMigration } from '@ttoss/postgresdb';

/**
 * Drops `eval_runs.passed`, the point verdict `eval_runs.verdict` replaces.
 * Neither this release nor the previous one reads or writes it.
 */
export const evalRunDropPassed = defineMigration({
  name: '2026-11-21-eval-run-drop-passed',
  description: 'eval_runs.passed dropped; eval_runs.verdict replaces it.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return !(await context.columnExists({
      table: 'eval_runs',
      column: 'passed',
    }));
  },
  up: async (context) => {
    context.say('dropping eval_runs.passed');
    await context.run({
      sql: 'ALTER TABLE eval_runs DROP COLUMN IF EXISTS passed;',
    });
  },
});
