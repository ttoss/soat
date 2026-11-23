/**
 * What a run is graded by: its Eval's `scorers`, `pass_threshold`, `group_by`
 * and `evidence`, copied onto the run when it is created (the evaluations module
 * doc — Version pinning). Every item and the settle read this copy, so an edit
 * to the Eval reaches only runs created after it.
 */
import { scorerList } from './evaluationScorerValidation';
import { isPlainObject } from './plainObject';

/**
 * The rules beyond the threshold, in the wire shape: `required_groups` for the
 * run's verdict, `live`, `max_run_age_days` and `min_calibration` for its
 * claim's.
 */
export type EvalEvidence = {
  required_groups?: string[];
  /** As written: the claims read parses it against the rules. */
  live?: unknown;
  max_run_age_days?: number;
  /** As written: the claims read parses it against the rules. */
  min_calibration?: unknown;
};

export type EvalRunDefinition = {
  scorers: unknown[];
  passThreshold: number | null;
  groupBy: string | null;
  evidence: EvalEvidence | null;
  /** As written: `validateCriteria` held it at the eval write. */
  criteria: unknown[] | null;
};

const requiredGroupsOf = (
  value: unknown
): Pick<EvalEvidence, 'required_groups'> => {
  if (!Array.isArray(value)) return {};
  return {
    required_groups: value.filter((group): group is string => {
      return typeof group === 'string';
    }),
  };
};

/**
 * Every rule the evidence declares, as the Eval's validator wrote it. `live`
 * stays as written, so one the rules do not read still reaches the claims
 * read, which reads its claim insufficient instead of passing without it.
 */
const evidenceOf = (value: unknown): EvalEvidence | null => {
  if (!isPlainObject(value)) return null;
  const age = value.max_run_age_days;
  return {
    ...requiredGroupsOf(value.required_groups),
    ...(value.live !== undefined &&
      value.live !== null && { live: value.live }),
    ...(typeof age === 'number' && { max_run_age_days: age }),
    ...(value.min_calibration !== undefined &&
      value.min_calibration !== null && {
        min_calibration: value.min_calibration,
      }),
  };
};

/** The definition a run created now records, from its Eval's current row. */
export const evalRunDefinitionOf = (args: {
  evaluation: {
    scorers: unknown;
    passThreshold: string | null;
    groupBy: string | null;
    evidence: unknown;
    criteria: unknown;
  };
}): EvalRunDefinition => {
  const { scorers, passThreshold, groupBy, evidence, criteria } =
    args.evaluation;
  return {
    scorers: scorerList(scorers),
    passThreshold: passThreshold === null ? null : Number(passThreshold),
    groupBy,
    evidence: evidenceOf(evidence),
    criteria: Array.isArray(criteria) ? criteria : null,
  };
};

/** The stored (and wire) form: `EvalRun.definition`. */
export const storedEvalRunDefinition = (args: {
  definition: EvalRunDefinition;
}): Record<string, unknown> => {
  return {
    scorers: args.definition.scorers,
    pass_threshold: args.definition.passThreshold,
    group_by: args.definition.groupBy,
    evidence: args.definition.evidence,
    criteria: args.definition.criteria,
  };
};

/**
 * The definition a run recorded, or null when it recorded none: such a run
 * cannot be scored or settled.
 */
export const readEvalRunDefinition = (args: {
  run: { definition: Record<string, unknown> | null };
}): EvalRunDefinition | null => {
  const stored = args.run.definition;
  if (!isPlainObject(stored) || !Array.isArray(stored.scorers)) return null;

  return {
    scorers: stored.scorers,
    passThreshold:
      typeof stored.pass_threshold === 'number' ? stored.pass_threshold : null,
    groupBy: typeof stored.group_by === 'string' ? stored.group_by : null,
    evidence: evidenceOf(stored.evidence),
    criteria: Array.isArray(stored.criteria) ? stored.criteria : null,
  };
};
