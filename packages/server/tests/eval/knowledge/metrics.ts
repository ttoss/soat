/**
 * Ranking metrics for the knowledge retrieval eval.
 *
 * Positions are **raw result positions**, never deduplicated by key: a document
 * occupying five of the ten slots is exactly what a caller experiences, and
 * collapsing it would hide the very behaviour a ranking change alters.
 */

/** Distinct keys, order preserved — the shape every metric below counts over. */
const unique = (keys: string[]): string[] => {
  return [...new Set(keys)];
};

const assertExpected = (expected: string[]): Set<string> => {
  const distinct = new Set(unique(expected));
  if (distinct.size === 0) {
    throw new Error(
      'a golden query must name at least one expected key; recall is undefined over an empty expected set'
    );
  }
  return distinct;
};

/**
 * 1-based position of the first relevant result, or `null` when the ranked list
 * holds none. `null` rather than `0` or `Infinity` so "not retrieved" cannot be
 * mistaken for a rank and silently averaged as one.
 */
export const firstRelevantRank = (args: {
  expected: string[];
  ranked: string[];
}): number | null => {
  const expected = assertExpected(args.expected);
  const index = args.ranked.findIndex((key) => {
    return expected.has(key);
  });
  return index === -1 ? null : index + 1;
};

/**
 * recall@k — the fraction of the distinct expected keys appearing in the first
 * `k` raw positions.
 */
export const recallAtK = (args: {
  expected: string[];
  ranked: string[];
  k: number;
}): number => {
  const expected = assertExpected(args.expected);
  if (!Number.isInteger(args.k) || args.k < 1) {
    throw new Error(`k must be a positive integer, received ${args.k}`);
  }
  const retrieved = new Set(args.ranked.slice(0, args.k));
  let hits = 0;
  for (const key of expected) {
    if (retrieved.has(key)) hits += 1;
  }
  return hits / expected.size;
};

/**
 * Mean reciprocal rank over the queries, scoring a query with no relevant
 * result as 0.
 */
export const meanReciprocalRank = (args: {
  ranks: Array<number | null>;
}): number => {
  if (args.ranks.length === 0) return 0;
  const total = args.ranks.reduce<number>((sum, rank) => {
    return sum + (rank === null ? 0 : 1 / rank);
  }, 0);
  return total / args.ranks.length;
};

const METRIC_PRECISION = 10000;

/**
 * Rounds a metric to four decimals. The report is committed as `baseline.json`
 * and compared byte for byte across runs, so the last bits of a float division
 * must never reach it. `-0` is folded to `0` for the same reason: it serializes
 * as `-0` and means nothing here.
 */
export const roundMetric = (value: number): number => {
  const rounded = Math.round(value * METRIC_PRECISION) / METRIC_PRECISION;
  return rounded === 0 ? 0 : rounded;
};
