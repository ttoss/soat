/**
 * Baseline comparison for eval runs (docs/prd-evaluations.md, Phase 2).
 *
 * A delta only means something when both sides answered the *same* question, so
 * every number here is computed over the **item intersection**: the dataset
 * items that are present and scorable in both runs. Anything else is reported as
 * divergence rather than folded into the comparison.
 *
 * That is the whole point of the module. Items have full CRUD and a run may
 * error on an item the baseline scored, so comparing the two runs' stored
 * aggregates would quietly attribute dataset drift to the agent — the fabricated
 * regression signal the evaluations module exists to prevent. Recomputing both
 * means over the intersection makes the comparison honest, and the
 * compared/added/removed counts make any drift visible instead of silent.
 *
 * Pure — no DB, no I/O — so the whole space of set differences is driven
 * directly in `tests/unit/tests/lib/evaluationDeltas.test.ts`.
 */
import createDebug from 'debug';

import type { ScorerOutcome } from './evaluationScorers';

const log = createDebug('soat:evaluations');

/** One run's per-item outcome, as the delta computation needs it. */
export type ComparableResult = {
  /**
   * The dataset item this result scored, or `null` when the fixture has since
   * been deleted. A null-keyed result can never be matched to its counterpart,
   * so it falls out of the intersection and shows up as divergence — which is
   * the honest reading: nothing identifies what it should be compared against.
   */
  datasetItemId: number | null;
  scores: ScorerOutcome[];
  errored: boolean;
  passed: boolean;
};

export type ScorerDelta = {
  /** Current mean − baseline mean, over the intersection. */
  mean_delta: number;
  /** Current pass rate − baseline pass rate, over the intersection. */
  pass_rate_delta: number;
};

export type BaselineComparison = {
  run_id: string;
  /** Items scorable in **both** runs — the basis of every delta below. */
  compared_item_count: number;
  /** Scorable here but not in the baseline (added, or errored there). */
  added_item_count: number;
  /** Scorable in the baseline but not here (removed, or errored here). */
  removed_item_count: number;
  /**
   * Run-level pass-rate delta over the intersection, or `null` when the two runs
   * share no comparable item — an honest "no comparison", never a 0 that reads
   * as "no change".
   */
  pass_rate_delta: number | null;
  /**
   * Per-scorer deltas, keyed by scorer type. A scorer present in only one of the
   * two runs (the Eval's scorers were edited between runs) is omitted rather
   * than compared against nothing.
   */
  scorers: Record<string, ScorerDelta>;
};

const ratio = (numerator: number, denominator: number): number => {
  return denominator === 0 ? 0 : numerator / denominator;
};

/** Indexes the scorable results of one run by the item they scored. */
const scorableByItem = (
  results: ComparableResult[]
): Map<number, ComparableResult> => {
  const byItem = new Map<number, ComparableResult>();
  for (const result of results) {
    if (result.errored || result.datasetItemId === null) continue;
    byItem.set(result.datasetItemId, result);
  }
  return byItem;
};

type ScorerRollup = { mean: number; passRate: number };

/** Mean score and pass rate for one scorer type across the given results. */
const rollupScorer = (args: {
  results: ComparableResult[];
  scorer: string;
}): ScorerRollup | null => {
  let total = 0;
  let passes = 0;
  let n = 0;

  for (const result of args.results) {
    for (const outcome of result.scores) {
      if (outcome.scorer !== args.scorer) continue;
      total += outcome.score;
      passes += outcome.passed ? 1 : 0;
      n += 1;
    }
  }

  // The scorer did not run on any compared item — there is nothing to average.
  if (n === 0) return null;
  return { mean: ratio(total, n), passRate: ratio(passes, n) };
};

/** Every scorer type that appears in either side's compared results. */
const comparedScorerTypes = (args: {
  current: ComparableResult[];
  baseline: ComparableResult[];
}): string[] => {
  const types = new Set<string>();
  for (const result of [...args.current, ...args.baseline]) {
    for (const outcome of result.scores) {
      types.add(outcome.scorer);
    }
  }
  return [...types].sort();
};

/**
 * Compares a finished run against a baseline run of the same Eval.
 *
 * Positive deltas mean the current run scored **higher** than the baseline.
 */
export const computeBaselineComparison = (args: {
  baselineRunPublicId: string;
  current: ComparableResult[];
  baseline: ComparableResult[];
}): BaselineComparison => {
  const currentByItem = scorableByItem(args.current);
  const baselineByItem = scorableByItem(args.baseline);

  const comparedItemIds = [...currentByItem.keys()].filter((itemId) => {
    return baselineByItem.has(itemId);
  });

  const currentCompared = comparedItemIds.map((itemId) => {
    return currentByItem.get(itemId)!;
  });
  const baselineCompared = comparedItemIds.map((itemId) => {
    return baselineByItem.get(itemId)!;
  });

  const scorers: Record<string, ScorerDelta> = {};
  for (const scorer of comparedScorerTypes({
    current: currentCompared,
    baseline: baselineCompared,
  })) {
    const now = rollupScorer({ results: currentCompared, scorer });
    const before = rollupScorer({ results: baselineCompared, scorer });
    // A scorer only one side ran (the Eval's scorers changed between runs) has
    // no counterpart to subtract, so it is left out instead of compared to zero.
    if (!now || !before) continue;
    scorers[scorer] = {
      mean_delta: now.mean - before.mean,
      pass_rate_delta: now.passRate - before.passRate,
    };
  }

  const passRateDelta =
    comparedItemIds.length === 0
      ? null
      : ratio(
          currentCompared.filter((result) => {
            return result.passed;
          }).length,
          currentCompared.length
        ) -
        ratio(
          baselineCompared.filter((result) => {
            return result.passed;
          }).length,
          baselineCompared.length
        );

  log(
    'computeBaselineComparison: baseline=%s compared=%d added=%d removed=%d',
    args.baselineRunPublicId,
    comparedItemIds.length,
    currentByItem.size - comparedItemIds.length,
    baselineByItem.size - comparedItemIds.length
  );

  return {
    run_id: args.baselineRunPublicId,
    compared_item_count: comparedItemIds.length,
    added_item_count: currentByItem.size - comparedItemIds.length,
    removed_item_count: baselineByItem.size - comparedItemIds.length,
    pass_rate_delta: passRateDelta,
    scorers,
  };
};
