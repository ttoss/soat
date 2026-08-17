/**
 * Run-level aggregation over per-item scorer outcomes (the evaluations module
 * doc — Pass semantics).
 *
 * Split from `evaluationScorers.ts` along the module's natural seam: scoring
 * produces one item's outcomes, aggregation rolls **persisted** outcomes up to
 * the run. The consumers differ too — the run finalizer computes these, while
 * the events and read paths only need the {@link AggregateScores} shape.
 *
 * Pure like the scorer kernel: a function of its arguments, no DB, no I/O —
 * driven directly in `tests/unit/tests/lib/evaluationScorers.test.ts`.
 */
import createDebug from 'debug';

import type { BaselineComparison } from './evaluationDeltas';
import type { ScorerOutcome } from './evaluationScorers';

const log = createDebug('soat:evaluations');

/** Per-scorer rollup plus the run-level pass rate, in the wire shape. */
export type AggregateScores = {
  scorers: Record<string, { mean: number; pass_rate: number }>;
  pass_rate: number | null;
  scored_item_count: number;
  /**
   * Present only when the run named a `baseline_run_id`. Computed over the item
   * intersection with divergence counts, so a delta is never presented as a
   * clean comparison when the two runs' item sets differ (`evaluationDeltas.ts`).
   */
  baseline?: BaselineComparison;
};

const ratio = (numerator: number, denominator: number): number => {
  return denominator === 0 ? 0 : numerator / denominator;
};

/**
 * Rolls per-item outcomes up to the run level.
 *
 * Only **non-errored** items are included: an item whose generation could not
 * be evaluated (a `requires_action` pause, a provider failure) says nothing
 * about the agent's answers, so counting it would depress the score with
 * infrastructure noise.
 *
 * `pass_rate` is `null` when nothing was scorable — an honest "no signal",
 * distinct from a genuine 0.
 */
export const aggregateScores = (args: {
  results: Array<{
    scores: ScorerOutcome[];
    passed: boolean;
    errored: boolean;
  }>;
}): AggregateScores => {
  const scored = args.results.filter((result) => {
    return !result.errored;
  });

  const byScorer = new Map<
    string,
    { total: number; passes: number; n: number }
  >();
  for (const result of scored) {
    for (const outcome of result.scores) {
      const bucket = byScorer.get(outcome.scorer) ?? {
        total: 0,
        passes: 0,
        n: 0,
      };
      bucket.total += outcome.score;
      bucket.passes += outcome.passed ? 1 : 0;
      bucket.n += 1;
      byScorer.set(outcome.scorer, bucket);
    }
  }

  const scorers: AggregateScores['scorers'] = {};
  for (const [scorer, bucket] of byScorer) {
    scorers[scorer] = {
      mean: ratio(bucket.total, bucket.n),
      pass_rate: ratio(bucket.passes, bucket.n),
    };
  }

  const passedItems = scored.filter((result) => {
    return result.passed;
  }).length;

  log(
    'aggregateScores: scored=%d passed=%d scorers=%d',
    scored.length,
    passedItems,
    byScorer.size
  );

  return {
    scorers,
    pass_rate: scored.length === 0 ? null : ratio(passedItems, scored.length),
    scored_item_count: scored.length,
  };
};

/**
 * The run-level verdict.
 *
 * Gates on the **pass rate**, never on a pooled mean: pooling 0/1 binaries with
 * 0–1 judge fractions produces a unit-less number whose meaning shifts whenever
 * a scorer is added — a gate value nobody can reason about
 * (the evaluations module doc — Pass semantics).
 *
 * `null` when the Eval declares no threshold (it reports without gating), and
 * `false` when a threshold exists but nothing was scorable — a run that
 * measured nothing must not read as a pass.
 */
export const resolveRunPassed = (args: {
  passThreshold: number | null;
  aggregate: AggregateScores;
}): boolean | null => {
  if (args.passThreshold === null) return null;
  if (args.aggregate.pass_rate === null) return false;
  return args.aggregate.pass_rate >= args.passThreshold;
};
