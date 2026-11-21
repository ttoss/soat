import { defineMigration } from '@ttoss/postgresdb';

/**
 * `evals.claim`, what an eval's runs test, and `eval_runs.claim`, the copy a
 * run takes at creation. Nothing to fill: no eval states a claim before this
 * column exists.
 */
export const evalClaim = defineMigration({
  name: '2026-11-21-eval-claim',
  description: 'evals.claim and eval_runs.claim, the claim a run tested.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return context.columnExists({ table: 'eval_runs', column: 'claim' });
  },
  up: async (context) => {
    context.say('adding evals.claim and eval_runs.claim');
    await context.run({
      sql: `ALTER TABLE evals ADD COLUMN IF NOT EXISTS claim json;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS claim json;`,
    });
  },
});
