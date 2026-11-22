/**
 * How far each scorer agrees with the people who labeled a run's results (the
 * evaluations module doc — Calibrating a judge), and the fingerprint that ties
 * that agreement to the scorers that graded.
 *
 * Pure: the label reads (`evaluationLabels.ts`) hand it the rows.
 */
import { scorerOutcomeKey } from './evaluationScorerValidation';
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
 * The scorers as the run recorded them and the decider versions it pinned,
 * digested without regard to key order: any change to what graded moves it.
 */
export const scorerFingerprint = (args: {
  scorers: unknown[];
  deciderVersions: Record<string, number> | null;
}): string => {
  return `sha256:${stableDigest({
    scorers: args.scorers,
    decider_versions: args.deciderVersions ?? {},
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
