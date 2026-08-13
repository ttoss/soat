import {
  type ComparableResult,
  computeBaselineComparison,
} from 'src/lib/evaluationDeltas';

/**
 * Baseline deltas (the evaluations module doc — Item snapshot).
 *
 * In `lib/` under the keep-list rule: the computation is a pure set-difference
 * algorithm whose input space is every way two runs' item sets can diverge, and
 * each case would otherwise need two full runs over a mutated dataset to reach
 * through REST. The wiring — that a run with `baseline_run_id` persists this
 * under `aggregate_scores.baseline` — is covered in `rest/evaluations.test.ts`.
 */
describe('evaluation baseline deltas', () => {
  const result = (args: {
    item: number | null;
    scores?: Array<{ scorer: string; score: number; passed: boolean }>;
    errored?: boolean;
    passed?: boolean;
  }): ComparableResult => {
    const scores = args.scores ?? [];
    return {
      datasetItemId: args.item,
      scores,
      errored: args.errored ?? false,
      passed:
        args.passed ??
        (scores.length > 0 &&
          scores.every((score) => {
            return score.passed;
          })),
    };
  };

  const contains = (score: number) => {
    return [{ scorer: 'contains', score, passed: score === 1 }];
  };

  const compare = (args: {
    current: ComparableResult[];
    baseline: ComparableResult[];
  }) => {
    return computeBaselineComparison({
      baselineRunPublicId: 'evrun_base',
      ...args,
    });
  };

  test('reports the baseline run id it compared against', () => {
    expect(
      compare({
        current: [result({ item: 1, scores: contains(1) })],
        baseline: [result({ item: 1, scores: contains(1) })],
      }).run_id
    ).toBe('evrun_base');
  });

  test('a scorer that improved reports positive deltas', () => {
    const comparison = compare({
      current: [
        result({ item: 1, scores: contains(1) }),
        result({ item: 2, scores: contains(1) }),
      ],
      baseline: [
        result({ item: 1, scores: contains(1) }),
        result({ item: 2, scores: contains(0) }),
      ],
    });

    expect(comparison.compared_item_count).toBe(2);
    expect(comparison.scorers.contains.mean_delta).toBeCloseTo(0.5);
    expect(comparison.scorers.contains.pass_rate_delta).toBeCloseTo(0.5);
    expect(comparison.pass_rate_delta).toBeCloseTo(0.5);
  });

  test('a scorer that regressed reports negative deltas', () => {
    const comparison = compare({
      current: [result({ item: 1, scores: contains(0) })],
      baseline: [result({ item: 1, scores: contains(1) })],
    });

    expect(comparison.scorers.contains.mean_delta).toBeCloseTo(-1);
    expect(comparison.pass_rate_delta).toBeCloseTo(-1);
  });

  test('an unchanged run reports zero deltas', () => {
    const comparison = compare({
      current: [result({ item: 1, scores: contains(1) })],
      baseline: [result({ item: 1, scores: contains(1) })],
    });

    expect(comparison.scorers.contains.mean_delta).toBe(0);
    expect(comparison.pass_rate_delta).toBe(0);
    expect(comparison.added_item_count).toBe(0);
    expect(comparison.removed_item_count).toBe(0);
  });

  // The whole point of the module: an item added or removed between the two runs
  // must be *counted*, never averaged into the delta, or dataset drift reads as
  // agent regression.
  describe('divergence', () => {
    test('computes deltas over the intersection only, and counts the rest', () => {
      const comparison = compare({
        current: [
          result({ item: 1, scores: contains(1) }),
          // Added since the baseline — a perfect score that must not inflate
          // the delta.
          result({ item: 2, scores: contains(1) }),
        ],
        baseline: [
          result({ item: 1, scores: contains(1) }),
          // Removed since the baseline — a zero that must not deflate it.
          result({ item: 3, scores: contains(0) }),
        ],
      });

      expect(comparison.compared_item_count).toBe(1);
      expect(comparison.added_item_count).toBe(1);
      expect(comparison.removed_item_count).toBe(1);
      expect(comparison.scorers.contains.mean_delta).toBe(0);
      expect(comparison.pass_rate_delta).toBe(0);
    });

    test('an item errored on one side falls out of the intersection', () => {
      const comparison = compare({
        current: [
          result({ item: 1, scores: contains(1) }),
          result({ item: 2, errored: true }),
        ],
        baseline: [
          result({ item: 1, scores: contains(1) }),
          result({ item: 2, scores: contains(0) }),
        ],
      });

      expect(comparison.compared_item_count).toBe(1);
      expect(comparison.removed_item_count).toBe(1);
      expect(comparison.added_item_count).toBe(0);
    });

    // A deleted fixture leaves the result with nothing identifying what it
    // should be compared against, so it is divergence rather than a match.
    test('a result whose dataset item was deleted cannot be matched', () => {
      const comparison = compare({
        current: [result({ item: null, scores: contains(1) })],
        baseline: [result({ item: 1, scores: contains(1) })],
      });

      expect(comparison.compared_item_count).toBe(0);
      expect(comparison.removed_item_count).toBe(1);
      expect(comparison.pass_rate_delta).toBeNull();
    });

    test('two runs sharing no item report no comparison rather than zero', () => {
      const comparison = compare({
        current: [result({ item: 1, scores: contains(1) })],
        baseline: [result({ item: 2, scores: contains(0) })],
      });

      expect(comparison.compared_item_count).toBe(0);
      expect(comparison.pass_rate_delta).toBeNull();
      expect(comparison.scorers).toEqual({});
    });
  });

  describe('scorer sets that differ between runs', () => {
    test('omits a scorer only one run ran', () => {
      const comparison = compare({
        current: [
          result({
            item: 1,
            scores: [
              { scorer: 'contains', score: 1, passed: true },
              { scorer: 'exact_match', score: 1, passed: true },
            ],
          }),
        ],
        baseline: [result({ item: 1, scores: contains(1) })],
      });

      expect(Object.keys(comparison.scorers)).toEqual(['contains']);
    });

    test('compares a continuous judge score like any other scorer', () => {
      const comparison = compare({
        current: [
          result({
            item: 1,
            scores: [{ scorer: 'llm_judge', score: 0.9, passed: true }],
          }),
        ],
        baseline: [
          result({
            item: 1,
            scores: [{ scorer: 'llm_judge', score: 0.6, passed: false }],
          }),
        ],
      });

      expect(comparison.scorers.llm_judge.mean_delta).toBeCloseTo(0.3);
      expect(comparison.scorers.llm_judge.pass_rate_delta).toBeCloseTo(1);
    });
  });
});
