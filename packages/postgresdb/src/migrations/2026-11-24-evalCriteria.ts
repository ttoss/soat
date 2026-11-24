import { defineMigration } from '@ttoss/postgresdb';

/**
 * `evals.criteria`, the properties an eval's claim is made of. Nothing to
 * fill: no eval declares criteria before this column exists, and a run
 * carries its copy inside `eval_runs.definition`.
 */
export const evalCriteria = defineMigration({
  name: '2026-11-24-eval-criteria',
  description: 'evals.criteria, the properties a claim is made of.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'evals' }))) return true;
    return context.columnExists({ table: 'evals', column: 'criteria' });
  },
  up: async (context) => {
    context.say('adding evals.criteria');
    await context.run({
      sql: 'ALTER TABLE evals ADD COLUMN IF NOT EXISTS criteria json;',
    });
  },
});
