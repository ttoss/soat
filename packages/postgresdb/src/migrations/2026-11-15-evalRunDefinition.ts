import { defineMigration } from '@ttoss/postgresdb';

/**
 * `eval_runs.agent_public_id` and `eval_runs.definition`, the agent a run
 * executes against and the scorers, threshold and grouping key it is graded
 * by. A run still `queued` or `running` takes its Eval's current values, which
 * are the ones its remaining items would have read; a terminal run records
 * none, so it satisfies no promotion gate.
 */
export const evalRunDefinition = defineMigration({
  name: '2026-11-15-eval-run-definition',
  description:
    'eval_runs.agent_public_id and definition, filled for queued and running runs.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return context.columnExists({ table: 'eval_runs', column: 'definition' });
  },
  up: async (context) => {
    context.say('adding eval_runs.agent_public_id and eval_runs.definition');
    await context.run({
      sql: `ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS agent_public_id varchar(32);
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS definition json;
UPDATE eval_runs AS r
SET agent_public_id = a.public_id,
    definition = json_build_object(
      'scorers', e.scorers,
      'pass_threshold', e.pass_threshold::float8,
      'group_by', e.group_by
    )
FROM evals AS e
JOIN agents AS a ON a.id = e.agent_id
WHERE r.eval_id = e.id
  AND r.status IN ('queued', 'running')
  AND r.definition IS NULL;`,
    });
  },
});
