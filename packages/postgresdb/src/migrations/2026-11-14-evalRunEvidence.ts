import { defineMigration } from '@ttoss/postgresdb';

/**
 * An eval run records what it measured, and its verdict reads the evidence:
 *
 * - `evals.evidence`: the rules a verdict reads beyond the threshold.
 * - `eval_runs.agent_public_id` and `eval_runs.definition`: the agent and the
 *   Eval's grading fields, fixed at run start.
 * - `eval_runs.verdict` and `eval_runs.verdict_reasons`.
 *
 * A run still `queued` or `running` receives its Eval's agent and fields, so it
 * settles from a definition like every run created afterwards. A settled run
 * keeps none: what graded it was not recorded, and copying today's Eval would
 * assert a fact nobody can check. Its `passed` column is kept.
 *
 * One statement string, so the columns never land without the live runs'
 * backfill: the probe reads `definition`, and a half-applied run would be
 * recorded as done. `json_build_object` keeps the scorers' key order.
 */
const UP_SQL = `
  ALTER TABLE evals ADD COLUMN IF NOT EXISTS evidence json;
  ALTER TABLE eval_runs
    ADD COLUMN IF NOT EXISTS agent_public_id varchar(32),
    ADD COLUMN IF NOT EXISTS definition json,
    ADD COLUMN IF NOT EXISTS verdict varchar(16),
    ADD COLUMN IF NOT EXISTS verdict_reasons json;
  UPDATE eval_runs AS run
     SET agent_public_id = agents.public_id,
         definition = json_build_object(
           'scorers', evals.scorers,
           'pass_threshold', evals.pass_threshold::float8,
           'group_by', evals.group_by,
           'evidence', evals.evidence
         )
    FROM evals
    JOIN agents ON agents.id = evals.agent_id
   WHERE run.eval_id = evals.id
     AND run.status IN ('queued', 'running')
     AND run.definition IS NULL;
`;

export const evalRunEvidence = defineMigration({
  name: '2026-11-14-eval-run-evidence',
  description:
    'evals.evidence; eval_runs agent_public_id, definition, verdict and verdict_reasons; live runs get their agent and definition.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'eval_runs' }))) return true;
    return context.columnExists({ table: 'eval_runs', column: 'definition' });
  },
  up: async (context) => {
    context.say('adding evidence and definitions, backfilling live runs');
    await context.run({ sql: UP_SQL });
  },
});
