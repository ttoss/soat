import { defineMigration } from '@ttoss/postgresdb';

/**
 * `evals.evidence`, the rules a verdict reads beyond the threshold, and
 * `eval_runs.verdict` / `eval_runs.verdict_reasons`. `eval_runs.passed` stays,
 * unwritten, until its contract: the previous release still selects it.
 */
export const evalRunVerdict = defineMigration({
  name: '2026-11-21-eval-run-verdict',
  description:
    'evals.evidence; eval_runs.verdict and verdict_reasons beside the unwritten passed.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return context.columnExists({ table: 'eval_runs', column: 'verdict' });
  },
  up: async (context) => {
    context.say('adding evals.evidence, eval_runs.verdict and verdict_reasons');
    await context.run({
      sql: `ALTER TABLE evals ADD COLUMN IF NOT EXISTS evidence json;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS verdict_reasons json;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS verdict varchar(16);`,
    });
  },
});
