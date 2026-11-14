/**
 * What a run is graded by (the evaluations module doc — Version pinning): the
 * Eval's `scorers`, `pass_threshold`, `group_by` and `evidence`, copied onto
 * the run when it is created.
 *
 * Every later step of the run reads this copy, never the Eval: items are scored
 * by its scorers and the run settles on its threshold, grouping and evidence.
 * The Eval stays editable, so this is what keeps a run's verdict a function of
 * what was true when it started.
 */
import type { EvalRow } from './evaluations';
import { isPlainObject } from './plainObject';

/** The rules a verdict reads beyond the threshold, in the wire shape. */
export type EvalEvidence = { required_groups?: string[] };

export type EvalRunDefinition = {
  scorers: unknown[];
  pass_threshold: number | null;
  group_by: string | null;
  evidence: EvalEvidence | null;
};

/** The Eval's grading fields, in the shape a run stores and serves. */
export const buildRunDefinition = (
  evaluation: Pick<
    EvalRow,
    'scorers' | 'passThreshold' | 'groupBy' | 'evidence'
  >
): EvalRunDefinition => {
  return {
    scorers: Array.isArray(evaluation.scorers) ? evaluation.scorers : [],
    pass_threshold:
      evaluation.passThreshold === null
        ? null
        : Number(evaluation.passThreshold),
    group_by: evaluation.groupBy,
    evidence: (evaluation.evidence as EvalEvidence | null) ?? null,
  };
};

/**
 * A run's stored definition, or null on a run that recorded none. Every run
 * that can still execute items holds one: run creation writes it, and the
 * migration `2026-11-14-eval-run-evidence` filled it for queued and running
 * runs.
 */
export const readRunDefinition = (run: {
  definition: Record<string, unknown> | null;
}): EvalRunDefinition | null => {
  if (!isPlainObject(run.definition)) return null;
  const { scorers, pass_threshold, group_by, evidence } = run.definition;
  return {
    scorers: Array.isArray(scorers) ? scorers : [],
    pass_threshold: typeof pass_threshold === 'number' ? pass_threshold : null,
    group_by: typeof group_by === 'string' ? group_by : null,
    evidence: isPlainObject(evidence) ? (evidence as EvalEvidence) : null,
  };
};
