import { defineMigration } from '@ttoss/postgresdb';

/**
 * `eval_runs.scorer_models` pins, per model-backed scorer, the model a run
 * grades under. Nullable with no default: a run without such a scorer pins
 * nothing.
 */
export const evalRunScorerModels = defineMigration({
  name: '2026-11-25-eval-run-scorer-models',
  description:
    'eval_runs.scorer_models pins the model each model-backed scorer grades under.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return context.columnExists({
      table: 'eval_runs',
      column: 'scorer_models',
    });
  },
  up: async (context) => {
    context.say('adding eval_runs.scorer_models');
    await context.run({
      sql: 'ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS scorer_models json;',
    });
  },
});
