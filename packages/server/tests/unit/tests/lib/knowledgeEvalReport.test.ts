import type { Metrics, Report } from 'tests/eval/knowledge/report';
import { findRegressions } from 'tests/eval/knowledge/report';

/**
 * The gate itself. `knowledgeRetrieval.eval.ts` needs a seeded corpus to run,
 * so what it compares against the baseline is covered here instead — over
 * hand-written reports, where a single metric can be moved at a time.
 */

const metrics = (values: Partial<Metrics>): Metrics => {
  return { recall_at_5: 1, recall_at_10: 1, mrr: 1, ...values };
};

const report = (args: {
  overall?: Partial<Metrics>;
  byKind?: Record<string, Partial<Metrics>>;
}): Report => {
  return {
    version: 1,
    metrics: metrics(args.overall ?? {}),
    by_kind: Object.fromEntries(
      Object.entries(args.byKind ?? {}).map(([kind, values]) => {
        return [kind, metrics(values)];
      })
    ),
    queries: [],
  };
};

describe('findRegressions', () => {
  test('passes a report that matches the baseline', () => {
    const baseline = report({ byKind: { freshness: {} } });
    expect(
      findRegressions({
        report: report({ byKind: { freshness: {} } }),
        baseline,
      })
    ).toEqual([]);
  });

  test('fails a recall@10 drop, overall and per kind', () => {
    const failures = findRegressions({
      report: report({
        overall: { recall_at_10: 0.8 },
        byKind: { semantic: { recall_at_10: 0.5 } },
      }),
      baseline: report({ byKind: { semantic: {} } }),
    });

    expect(failures).toEqual([
      { scope: 'overall', metric: 'recall_at_10', baseline: 1, current: 0.8 },
      { scope: 'semantic', metric: 'recall_at_10', baseline: 1, current: 0.5 },
    ]);
  });

  test('fails an MRR drop at unchanged recall', () => {
    // The reason the gate compares MRR at all: the recency blend can only
    // demote a result, so recall@10 never moves upward for it and a kind whose
    // fresh entry fell from rank 1 to rank 2 would pass a recall-only gate.
    const failures = findRegressions({
      report: report({
        overall: { mrr: 0.75 },
        byKind: { freshness: { mrr: 0.5 } },
      }),
      baseline: report({ byKind: { freshness: {} } }),
    });

    expect(failures).toEqual([
      { scope: 'overall', metric: 'mrr', baseline: 1, current: 0.75 },
      { scope: 'freshness', metric: 'mrr', baseline: 1, current: 0.5 },
    ]);
  });

  test('passes a report that improves on the baseline', () => {
    expect(
      findRegressions({
        report: report({ byKind: { freshness: {} } }),
        baseline: report({
          overall: { recall_at_10: 0.5, mrr: 0.5 },
          byKind: { freshness: { mrr: 0.5 } },
        }),
      })
    ).toEqual([]);
  });

  test('fails every gated metric of a kind the run no longer scores', () => {
    const failures = findRegressions({
      report: report({}),
      baseline: report({ byKind: { freshness: {} } }),
    });

    expect(failures).toEqual([
      {
        scope: 'freshness (absent from this run)',
        metric: 'recall_at_10',
        baseline: 1,
        current: 0,
      },
      {
        scope: 'freshness (absent from this run)',
        metric: 'mrr',
        baseline: 1,
        current: 0,
      },
    ]);
  });

  test('ignores recall@5, which the gate does not compare', () => {
    expect(
      findRegressions({
        report: report({ overall: { recall_at_5: 0 } }),
        baseline: report({}),
      })
    ).toEqual([]);
  });
});
