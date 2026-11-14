/**
 * The verdict algebra (the evaluations module doc — Pass semantics): what an
 * interval says about a threshold, and how several judged scopes combine.
 *
 * Pure: every caller hands it figures it already holds. The run's settlement
 * is the one caller today; anything later that judges evidence imports these
 * types and functions rather than re-deriving them.
 */
import type { PassRateInterval } from './evaluationStatistics';

export type Verdict = 'supported' | 'refuted' | 'insufficient';

/** What a reason judges. A structured scope, never a `kind:name` string. */
export type VerdictScope = { kind: 'run' } | { kind: 'group'; name: string };

export type VerdictReason = {
  scope: VerdictScope;
  verdict: Verdict;
  reason: string;
};

const SEVERITY: Record<Verdict, number> = {
  supported: 0,
  insufficient: 1,
  refuted: 2,
};

const figure = (value: number): string => {
  return String(Math.round(value * 100) / 100);
};

/**
 * Where an interval sits against a threshold: wholly at or above it is
 * `supported`, wholly below it is `refuted`, and holding it, or having nothing
 * scored, is `insufficient`. The interval carries the sample size, so a small
 * suite cannot read as `supported` on a lucky point estimate.
 */
export const intervalVerdict = (args: {
  interval: PassRateInterval | null;
  threshold: number;
}): { verdict: Verdict; reason: string } => {
  const { interval, threshold } = args;
  if (interval === null) {
    return { verdict: 'insufficient', reason: 'no scored items' };
  }
  const range = `interval ${figure(interval.low)}–${figure(interval.high)}`;
  if (interval.low >= threshold) {
    return {
      verdict: 'supported',
      reason: `${range} at or above ${threshold}`,
    };
  }
  if (interval.high < threshold) {
    return { verdict: 'refuted', reason: `${range} below ${threshold}` };
  }
  return { verdict: 'insufficient', reason: `${range} contains ${threshold}` };
};

/** The most severe verdict: `refuted` over `insufficient` over `supported`. */
export const worstVerdict = (reasons: VerdictReason[]): Verdict => {
  return reasons.reduce<Verdict>((worst, { verdict }) => {
    return SEVERITY[verdict] > SEVERITY[worst] ? verdict : worst;
  }, 'supported');
};
