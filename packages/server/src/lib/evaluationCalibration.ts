/**
 * How far each scorer agrees with the people who labeled a run's results (the
 * evaluations module doc — Calibrating a judge), and the fingerprint that ties
 * that agreement to the scorers that graded.
 *
 * Pure: the label reads (`evaluationLabels.ts`) hand it the rows.
 */
import type { ScorerModels } from './evaluationScorerModels';
import {
  EXTERNALLY_GRADED,
  isScorerType,
  scorerOutcomeKey,
} from './evaluationScorerValidation';
import type { VerdictReason } from './evaluationVerdict';
import { isPlainObject } from './plainObject';
import { stableDigest } from './stableDigest';

export type ScorerCalibration = {
  labeled: number;
  agreement: number | null;
  false_pass: number;
  false_fail: number;
};

export type RunCalibration = {
  labeled_count: number;
  scorers: Record<string, ScorerCalibration>;
};

/**
 * Each scorer's configuration under its outcome key, and the decider versions
 * and scorer models the run pinned, digested without regard to key order: any
 * change to what graded, or to which key a configuration answers under, moves
 * it. A model route's content is not versioned, so an edit to the route a
 * judge pinned leaves the fingerprint in place. The name
 * is the key rather than part of the configuration, so naming a scorer after
 * the key it already had leaves its labels counting.
 */
export const scorerFingerprint = (args: {
  scorers: unknown[];
  deciderVersions: Record<string, number> | null;
  scorerModels: ScorerModels | null;
}): string => {
  const byKey: Record<string, unknown> = {};
  for (const scorer of args.scorers) {
    if (!isPlainObject(scorer)) continue;
    const { name: _name, ...config } = scorer;
    byKey[scorerOutcomeKey(scorer)] = config;
  }
  return `sha256:${stableDigest({
    scorers: byKey,
    decider_versions: args.deciderVersions ?? {},
    scorer_models: args.scorerModels ?? {},
  })}`;
};

const outcomesOf = (scores: unknown): Map<string, boolean> => {
  const outcomes = new Map<string, boolean>();
  if (!Array.isArray(scores)) return outcomes;
  for (const outcome of scores) {
    if (isPlainObject(outcome) && typeof outcome.passed === 'boolean') {
      outcomes.set(String(outcome.scorer), outcome.passed);
    }
  }
  return outcomes;
};

const count = (args: {
  tally: ScorerCalibration;
  passed: boolean;
  humanPassed: boolean;
}): void => {
  args.tally.labeled += 1;
  if (args.passed && !args.humanPassed) args.tally.false_pass += 1;
  if (!args.passed && args.humanPassed) args.tally.false_fail += 1;
};

/**
 * Each scorer the run graded with, against the labeled results it scored: a
 * scorer passing what the person failed is a false pass, the reverse a false
 * fail. A scorer with nothing labeled has no agreement.
 */
export const calibrationOf = (args: {
  scorers: unknown[];
  labeled: Array<{ scores: unknown; humanPassed: boolean }>;
}): RunCalibration => {
  const scorers: Record<string, ScorerCalibration> = {};
  for (const scorer of args.scorers) {
    if (!isPlainObject(scorer)) continue;
    scorers[scorerOutcomeKey(scorer)] = {
      labeled: 0,
      agreement: null,
      false_pass: 0,
      false_fail: 0,
    };
  }
  for (const result of args.labeled) {
    for (const [key, passed] of outcomesOf(result.scores)) {
      const tally = scorers[key];
      if (tally) count({ tally, passed, humanPassed: result.humanPassed });
    }
  }
  for (const tally of Object.values(scorers)) {
    const agreed = tally.labeled - tally.false_pass - tally.false_fail;
    tally.agreement = tally.labeled === 0 ? null : agreed / tally.labeled;
  }
  return { labeled_count: args.labeled.length, scorers };
};

export type MinCalibration = { labeled: number; agreement: number };

/** `evidence.min_calibration` read against its rule, or the first problem in it. */
export const parseMinCalibration = (
  value: unknown
): { rule: MinCalibration } | { problem: string } => {
  const path = 'evidence.min_calibration';
  if (!isPlainObject(value)) return { problem: `${path} must be an object.` };
  const extra = Object.keys(value).find((key) => {
    return key !== 'labeled' && key !== 'agreement';
  });
  if (extra !== undefined) {
    return { problem: `${path}.${extra} is not a known field.` };
  }
  const { labeled, agreement } = value;
  if (!(Number.isInteger(labeled) && Number(labeled) >= 1)) {
    return { problem: `${path}.labeled must be a positive integer.` };
  }
  if (
    typeof agreement !== 'number' ||
    !Number.isFinite(agreement) ||
    agreement < 0 ||
    agreement > 1
  ) {
    return { problem: `${path}.agreement must be a number between 0 and 1.` };
  }
  return { rule: { labeled: Number(labeled), agreement } };
};

/** The outcome keys of the scorers whose verdict comes from outside the eval. */
export const externallyGradedKeys = (scorers: unknown[]): string[] => {
  return scorers.flatMap((scorer) => {
    if (!isPlainObject(scorer) || !isScorerType(scorer.type)) return [];
    return EXTERNALLY_GRADED[scorer.type] ? [scorerOutcomeKey(scorer)] : [];
  });
};

const figure = (value: number): string => {
  return String(Math.round(value * 1000) / 1000);
};

/**
 * One reason per externally graded scorer, read over the labels of every run
 * graded by the same scorers taken together: the labels measure the scorer,
 * not the run, so no single run's luck can carry the rule.
 */
export const calibrationReasons = (args: {
  rule: MinCalibration;
  keys: string[];
  runs: RunCalibration[];
}): VerdictReason[] => {
  const { rule } = args;
  return args.keys.map((name): VerdictReason => {
    let labeled = 0;
    let disagreed = 0;
    for (const run of args.runs) {
      const tally = run.scorers[name];
      if (!tally) continue;
      labeled += tally.labeled;
      disagreed += tally.false_pass + tally.false_fail;
    }
    const scope = { kind: 'calibration' as const, name };
    if (labeled < rule.labeled) {
      return {
        scope,
        verdict: 'insufficient',
        reason: `${labeled} labeled, ${rule.labeled} required`,
      };
    }
    const agreement = (labeled - disagreed) / labeled;
    return agreement >= rule.agreement
      ? {
          scope,
          verdict: 'supported',
          reason: `agreement ${figure(agreement)} at or above ${rule.agreement}`,
        }
      : {
          scope,
          verdict: 'insufficient',
          reason: `agreement ${figure(agreement)} below ${rule.agreement}`,
        };
  });
};

/** The reason a run's recorded `min_calibration` gives when it does not read. */
export const unreadableCalibrationReason = (): VerdictReason => {
  return {
    scope: { kind: 'calibration', name: 'unreadable' },
    verdict: 'insufficient',
    reason:
      'the evidence.min_calibration recorded on the run does not read against the rules',
  };
};
