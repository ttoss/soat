/**
 * What a run is graded by: its Eval's `scorers`, `pass_threshold`, `group_by`
 * and `evidence`, copied onto the run when it is created (the evaluations module
 * doc — Version pinning). Every item and the settle read this copy, so an edit
 * to the Eval reaches only runs created after it.
 */
import { type LiveEvidence, parseLiveEvidence } from './claimLiveEvidence';
import { scorerList } from './evaluationScorerValidation';
import { isPlainObject } from './plainObject';

/** A recorded `live` the rules do not read, kept as it was written. */
export type UnreadableLive = { unreadable: unknown };

/**
 * The rules beyond the threshold, in the wire shape: `required_groups` for the
 * run's verdict, `live` and `max_run_age_days` for its claim's.
 */
export type EvalEvidence = {
  required_groups?: string[];
  live?: LiveEvidence | UnreadableLive;
  max_run_age_days?: number;
};

export type EvalRunDefinition = {
  scorers: unknown[];
  passThreshold: number | null;
  groupBy: string | null;
  evidence: EvalEvidence | null;
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

const liveOf = (value: unknown): Pick<EvalEvidence, 'live'> => {
  if (value === undefined || value === null) return {};
  const parsed = parseLiveEvidence(value);
  return { live: 'live' in parsed ? parsed.live : { unreadable: value } };
};

/**
 * Every rule the evidence declares, read as the Eval's validator wrote it. A
 * recorded `live` the rules do not read is kept as {@link UnreadableLive}, so
 * the claim it governs reads insufficient instead of passing without it.
 */
const evidenceOf = (value: unknown): EvalEvidence | null => {
  if (!isPlainObject(value)) return null;
  const age = value.max_run_age_days;
  return {
    ...requiredGroupsOf(value.required_groups),
    ...liveOf(value.live),
    ...(typeof age === 'number' && { max_run_age_days: age }),
  };
};

/** The definition a run created now records, from its Eval's current row. */
export const evalRunDefinitionOf = (args: {
  evaluation: {
    scorers: unknown;
    passThreshold: string | null;
    groupBy: string | null;
    evidence: unknown;
  };
}): EvalRunDefinition => {
  const { scorers, passThreshold, groupBy, evidence } = args.evaluation;
  return {
    scorers: scorerList(scorers),
    passThreshold: passThreshold === null ? null : Number(passThreshold),
    groupBy,
    evidence: evidenceOf(evidence),
  };
};

/** The evidence as written: an unreadable `live` goes back as it came. */
const storedEvidence = (
  evidence: EvalEvidence | null
): Record<string, unknown> | null => {
  if (evidence?.live === undefined || !('unreadable' in evidence.live)) {
    return evidence;
  }
  return { ...evidence, live: evidence.live.unreadable };
};

/** The stored (and wire) form: `EvalRun.definition`. */
export const storedEvalRunDefinition = (args: {
  definition: EvalRunDefinition;
}): Record<string, unknown> => {
  return {
    scorers: args.definition.scorers,
    pass_threshold: args.definition.passThreshold,
    group_by: args.definition.groupBy,
    evidence: storedEvidence(args.definition.evidence),
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
  };
};
