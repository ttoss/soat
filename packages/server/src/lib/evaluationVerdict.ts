/**
 * The verdict algebra (the evaluations module doc — Pass semantics): what an
 * interval says about a threshold, and how several judged scopes combine.
 *
 * Pure: every caller hands it figures it already holds. Anything that judges
 * evidence imports these types and functions rather than re-deriving them.
 */
import { criterionBindings } from './evaluationCriteria';
import type { EvalRunDefinition } from './evaluationRunDefinition';
import type { AggregateScores } from './evaluationScorerAggregation';
import type { PassRateInterval } from './evaluationStatistics';

export type Verdict = 'supported' | 'refuted' | 'insufficient';

/** What a reason judges. A structured scope, never a `kind:name` string. */
export type VerdictScope =
  | { kind: 'run' }
  | { kind: 'group'; name: string }
  | { kind: 'live'; name: string }
  | { kind: 'age' }
  | { kind: 'calibration'; name: string }
  | { kind: 'criterion'; name: string };

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

/** A stored verdict, read back: anything else is no verdict. */
export const isVerdict = (value: unknown): value is Verdict => {
  return typeof value === 'string' && Object.hasOwn(SEVERITY, value);
};

/** The more severe of two verdicts. */
export const worseOf = (args: { a: Verdict; b: Verdict }): Verdict => {
  return SEVERITY[args.b] > SEVERITY[args.a] ? args.b : args.a;
};

/** The most severe verdict: `refuted` over `insufficient` over `supported`. */
export const worstVerdict = (reasons: VerdictReason[]): Verdict => {
  return reasons.reduce<Verdict>((worst, { verdict }) => {
    return worseOf({ a: worst, b: verdict });
  }, 'supported');
};

/** Each required group judged on its own interval; a missing one scored nothing. */
const requiredGroupReasons = (args: {
  groups: string[];
  aggregate: AggregateScores;
  threshold: number;
}): VerdictReason[] => {
  return args.groups.map((name) => {
    return {
      scope: { kind: 'group', name },
      ...intervalVerdict({
        interval:
          args.aggregate.grouping?.groups[name]?.pass_rate_interval ?? null,
        threshold: args.threshold,
      }),
    };
  });
};

/**
 * One reason per criterion, judged on its own interval against the run's
 * threshold. A criterion is never worse than the run on the same items, since
 * the run's item passes only when every scorer does: the reasons say which
 * property lost the items.
 */
const criterionReasons = (args: {
  criteria: unknown;
  aggregate: AggregateScores;
  threshold: number;
}): VerdictReason[] => {
  return criterionBindings(args.criteria).map(({ name }) => {
    return {
      scope: { kind: 'criterion', name },
      ...intervalVerdict({
        interval: args.aggregate.criteria?.[name]?.pass_rate_interval ?? null,
        threshold: args.threshold,
      }),
    };
  });
};

/**
 * The run's verdict and why: the run's own interval against the threshold,
 * then each group `evidence.required_groups` names, judged by the same rule on
 * its own interval. The verdict is the worst of them; groups the evidence does
 * not require stay report-only. Null without a threshold: the Eval reports
 * scores without gating on them.
 */
export const runVerdict = (args: {
  settlement: Pick<
    EvalRunDefinition,
    'passThreshold' | 'evidence' | 'criteria'
  >;
  aggregate: AggregateScores;
}): { verdict: Verdict | null; reasons: VerdictReason[] | null } => {
  const threshold = args.settlement.passThreshold;
  if (threshold === null) return { verdict: null, reasons: null };

  const reasons: VerdictReason[] = [
    {
      scope: { kind: 'run' },
      ...intervalVerdict({
        interval: args.aggregate.pass_rate_interval,
        threshold,
      }),
    },
    ...requiredGroupReasons({
      groups: args.settlement.evidence?.required_groups ?? [],
      aggregate: args.aggregate,
      threshold,
    }),
    ...criterionReasons({
      criteria: args.settlement.criteria,
      aggregate: args.aggregate,
      threshold,
    }),
  ];
  return { verdict: worstVerdict(reasons), reasons };
};
