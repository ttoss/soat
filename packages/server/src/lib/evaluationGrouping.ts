/**
 * Grouped aggregates for eval runs (the evaluations module doc — Grouped
 * aggregates).
 *
 * An Eval's `group_by` names a key of its items' `metadata`; each string value
 * of that key is a group, rolled up by the same functions that roll up the
 * run, so a group's figures cannot mean something different from the run's.
 *
 * Labels are keyed by dataset item and read once per settle: the two sides of
 * a baseline comparison group the same item under the same label, so a delta
 * per group compares like with like even when an item was relabelled between
 * the runs.
 *
 * Pure — the DB read that supplies the labels lives with the finalizer.
 */
import {
  type BaselineComparison,
  type ComparableResult,
  computeBaselineComparison,
} from './evaluationDeltas';
import {
  type AggregateScores,
  aggregateScores,
} from './evaluationScorerAggregation';
import { isPlainObject } from './plainObject';

type Rollup = Omit<AggregateScores, 'baseline' | 'grouping'>;

type Comparison = Omit<BaselineComparison, 'run_id' | 'grouping'>;

export type RunGrouping = {
  group_by: string;
  groups: Record<string, Rollup>;
  /** Scored items whose `metadata` holds no string under `group_by`. */
  ungrouped_item_count: number;
};

export type BaselineGrouping = {
  group_by: string;
  groups: Record<string, Comparison>;
  /** Items scorable in both runs whose `metadata` names no group. */
  ungrouped_item_count: number;
};

/**
 * The group an item's `metadata` names, or null. Only a string names one:
 * coercing `1` and `"1"` to one label would merge two groups the caller wrote
 * apart.
 */
export const groupLabel = (args: {
  metadata: unknown;
  groupBy: string;
}): string | null => {
  if (!isPlainObject(args.metadata)) return null;
  // An absent key reads `undefined`, and every key a bag inherits from
  // `Object.prototype` is a function or an object: neither is a string.
  const value = args.metadata[args.groupBy];
  return typeof value === 'string' ? value : null;
};

const labelOf = (
  labels: Map<number, string>,
  result: ComparableResult
): string | null => {
  if (result.datasetItemId === null) return null;
  return labels.get(result.datasetItemId) ?? null;
};

/** The results labelled `label`; `null` selects the ones that name no group. */
const inGroup = (args: {
  labels: Map<number, string>;
  results: ComparableResult[];
  label: string | null;
}): ComparableResult[] => {
  return args.results.filter((result) => {
    return labelOf(args.labels, result) === args.label;
  });
};

/** Every label the results name, sorted so the wire order is deterministic. */
const labelsNamed = (
  labels: Map<number, string>,
  results: ComparableResult[]
): string[] => {
  const named = new Set<string>();
  for (const result of results) {
    const label = labelOf(labels, result);
    if (label !== null) named.add(label);
  }
  return [...named].sort();
};

/**
 * Rolls a run's results up per group. An errored item scores nothing, so it
 * counts in no group, as it counts in no run-level figure.
 */
export const aggregateGroups = (args: {
  groupBy: string;
  labels: Map<number, string>;
  results: ComparableResult[];
}): RunGrouping => {
  const scored = args.results.filter((result) => {
    return !result.errored;
  });

  // `Object.fromEntries` defines own properties, so a caller's label spelled
  // `__proto__` is a group rather than a prototype assignment.
  return {
    group_by: args.groupBy,
    groups: Object.fromEntries(
      labelsNamed(args.labels, scored).map((label) => {
        return [
          label,
          aggregateScores({
            results: inGroup({ labels: args.labels, results: scored, label }),
          }),
        ];
      })
    ),
    ungrouped_item_count: inGroup({
      labels: args.labels,
      results: scored,
      label: null,
    }).length,
  };
};

/**
 * Compares each group against the same group of the baseline run. A group
 * only one run names compares against an empty side, so its items read as
 * added or removed rather than vanishing from the comparison.
 */
export const compareGroups = (args: {
  groupBy: string;
  labels: Map<number, string>;
  baselineRunPublicId: string;
  current: ComparableResult[];
  baseline: ComparableResult[];
}): BaselineGrouping => {
  const compare = (label: string | null): BaselineComparison => {
    return computeBaselineComparison({
      baselineRunPublicId: args.baselineRunPublicId,
      current: inGroup({ labels: args.labels, results: args.current, label }),
      baseline: inGroup({ labels: args.labels, results: args.baseline, label }),
    });
  };

  return {
    group_by: args.groupBy,
    groups: Object.fromEntries(
      labelsNamed(args.labels, [...args.current, ...args.baseline]).map(
        (label) => {
          const {
            run_id: _runId,
            grouping: _grouping,
            ...comparison
          } = compare(label);
          return [label, comparison];
        }
      )
    ),
    ungrouped_item_count: compare(null).compared_item_count,
  };
};
