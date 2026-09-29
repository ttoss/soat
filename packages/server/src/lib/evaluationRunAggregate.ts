/**
 * A settled run's aggregate, assembled from its **persisted** results (the
 * evaluations module doc — Pass semantics, Baseline deltas, Grouped
 * aggregates): the run-level rollup, the comparison against its baseline run,
 * and the per-group figures when the Eval declares a `group_by`.
 *
 * The finalizer (`evaluationRunExecution.ts`) is the only caller; the rollups
 * themselves are the pure functions this module feeds.
 */
import { db } from '../db';
import {
  type ComparableResult,
  computeBaselineComparison,
} from './evaluationDeltas';
import {
  aggregateGroups,
  compareGroups,
  groupLabel,
} from './evaluationGrouping';
import {
  type AggregateScores,
  aggregateScores,
} from './evaluationScorerAggregation';
import type { ScorerOutcome } from './evaluationScorers';

type EvalRunRowInstance = InstanceType<(typeof db)['EvalRun']>;
type ResultRow = InstanceType<(typeof db)['EvalResult']>;

/**
 * `scores` is a NOT NULL JSONB column only ever written from `scoreOutput`, so it
 * is always an array — there is no absent-value case to defend against.
 */
const resultScores = (row: ResultRow): ScorerOutcome[] => {
  return row.scores as ScorerOutcome[];
};

const toComparable = (row: ResultRow): ComparableResult => {
  return {
    datasetItemId: row.datasetItemId,
    scores: resultScores(row),
    errored: row.error !== null,
    passed: row.passed,
  };
};

/** The baseline run's public id and results, or null when the run named none. */
const loadBaseline = async (args: {
  baselineRunDbId: number | null;
}): Promise<{ publicId: string; results: ComparableResult[] } | null> => {
  if (args.baselineRunDbId === null) return null;

  const baselineRun = await db.EvalRun.findByPk(args.baselineRunDbId, {
    attributes: ['id', 'publicId'],
  });
  /* istanbul ignore next -- the FK is ON DELETE SET NULL, so a surviving id
     always resolves to a row. */
  if (!baselineRun) return null;

  const baselineResults = await db.EvalResult.findAll({
    where: { evalRunId: args.baselineRunDbId },
  });
  return {
    publicId: baselineRun.publicId,
    results: baselineResults.map(toComparable),
  };
};

/** Each still-existing item's group, read from its current `metadata`. */
const loadGroupLabels = async (args: {
  groupBy: string;
  results: ComparableResult[];
}): Promise<Map<number, string>> => {
  const itemIds = [
    ...new Set(
      args.results.flatMap((result) => {
        return result.datasetItemId === null ? [] : [result.datasetItemId];
      })
    ),
  ];
  const items = await db.DatasetItem.findAll({
    where: { id: itemIds },
    attributes: ['id', 'metadata'],
  });

  const labels = new Map<number, string>();
  for (const item of items) {
    const label = groupLabel({
      metadata: item.metadata,
      groupBy: args.groupBy,
    });
    if (label !== null) labels.set(item.id as number, label);
  }
  return labels;
};

/** The run's aggregate, with its baseline comparison and grouping attached. */
export const buildRunAggregate = async (args: {
  run: EvalRunRowInstance;
  groupBy: string | null;
  results: ResultRow[];
}): Promise<AggregateScores> => {
  const current = args.results.map(toComparable);
  const baseline = await loadBaseline({
    baselineRunDbId: args.run.baselineRunId,
  });
  const grouping =
    args.groupBy === null
      ? null
      : {
          groupBy: args.groupBy,
          labels: await loadGroupLabels({
            groupBy: args.groupBy,
            results: [...current, ...(baseline?.results ?? [])],
          }),
        };

  const aggregate = aggregateScores({ results: current });
  if (grouping) {
    aggregate.grouping = aggregateGroups({ ...grouping, results: current });
  }
  if (baseline) {
    const comparison = computeBaselineComparison({
      baselineRunPublicId: baseline.publicId,
      current,
      baseline: baseline.results,
    });
    if (grouping) {
      comparison.grouping = compareGroups({
        ...grouping,
        baselineRunPublicId: baseline.publicId,
        current,
        baseline: baseline.results,
      });
    }
    aggregate.baseline = comparison;
  }
  return aggregate;
};
