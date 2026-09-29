/**
 * Uncertainty on an eval run's figures (the evaluations module doc —
 * Uncertainty).
 *
 * Two closed-form statistics, chosen for the small datasets evals run on:
 *
 * - the **Wilson score interval** around a pass rate, which stays inside 0–1
 *   and keeps its coverage at a handful of items and at rates near 0 or 1,
 *   where the normal approximation does neither;
 * - the **exact McNemar test** on a baseline comparison, which reads only the
 *   items that changed sides: when nothing changed, an item is as likely to
 *   flip one way as the other, whether the flip comes from the dataset or
 *   from the model's own randomness.
 *
 * Pure, so both are driven directly in
 * `tests/unit/tests/lib/evaluationStatistics.test.ts`.
 */

/** The confidence level every interval is reported at. */
export const INTERVAL_LEVEL = 0.95;

/** The standard normal quantile for a two-sided {@link INTERVAL_LEVEL}. */
const Z = 1.959963984540054;

export type PassRateInterval = { low: number; high: number; level: number };

/**
 * The Wilson score interval for `passed` of `total`, or null when nothing was
 * scored — no measurement has no uncertainty to report.
 */
export const wilsonInterval = (args: {
  passed: number;
  total: number;
}): PassRateInterval | null => {
  if (args.total === 0) return null;

  const rate = args.passed / args.total;
  const zSquared = Z * Z;
  const denominator = 1 + zSquared / args.total;
  const center = (rate + zSquared / (2 * args.total)) / denominator;
  const halfWidth =
    (Z *
      Math.sqrt(
        (rate * (1 - rate)) / args.total +
          zSquared / (4 * args.total * args.total)
      )) /
    denominator;

  // At 0 and at `total` passes the bound is exactly 0 or 1; the floating-point
  // center ± half-width lands a rounding error either side of it.
  return {
    low: args.passed === 0 ? 0 : center - halfWidth,
    high: args.passed === args.total ? 1 : center + halfWidth,
    level: INTERVAL_LEVEL,
  };
};

/**
 * The two-sided exact McNemar p-value for a split of `improved` against
 * `regressed` items: the probability, were a flip equally likely either way,
 * of a split at least this uneven.
 *
 * The binomial terms are summed in log space: `0.5 ** n` underflows to 0 past
 * about a thousand flipped items, which would read as certainty.
 */
export const exactMcNemarPValue = (args: {
  improved: number;
  regressed: number;
}): number => {
  const flipped = args.improved + args.regressed;
  const tail = Math.min(args.improved, args.regressed);

  // log C(n, k) · 0.5^n for k = 0…tail, built up term by term.
  const logTerms: number[] = [];
  let logTerm = -flipped * Math.LN2;
  for (let k = 0; k <= tail; k += 1) {
    logTerms.push(logTerm);
    logTerm += Math.log((flipped - k) / (k + 1));
  }

  // The terms grow with k up to tail ≤ n/2, so the last is the largest.
  const largest = logTerms[logTerms.length - 1]!;
  const scaledSum = logTerms.reduce((sum, term) => {
    return sum + Math.exp(term - largest);
  }, 0);

  return Math.min(1, 2 * Math.exp(largest) * scaledSum);
};
