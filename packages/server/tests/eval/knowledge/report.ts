import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { GoldenQuery, GoldenQueryKind } from './goldenSet';
import {
  firstRelevantRank,
  meanReciprocalRank,
  recallAtK,
  roundMetric,
} from './metrics';

/**
 * The eval's report, and the committed baseline it is gated against — one
 * shape, so every ranking change lands as a diff of `baseline.json`.
 *
 * Deliberately carries no timestamp and no ranking label: the report must be
 * byte-identical across two consecutive runs, and the label would be redundant
 * with the diff.
 */

/** The result ceiling every golden query is run at — also the largest `k`. */
export const RESULT_LIMIT = 10;

export type Metrics = {
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
};

export type QueryRow = {
  id: string;
  kind: GoldenQueryKind;
  first_relevant_rank: number | null;
  hit_at_5: boolean;
  hit_at_10: boolean;
  recall_at_5: number;
  recall_at_10: number;
};

export type Report = {
  version: number;
  metrics: Metrics;
  by_kind: Record<string, Metrics>;
  queries: QueryRow[];
};

export const REPORT_PATH = path.join(__dirname, 'report.json');
export const BASELINE_PATH = path.join(__dirname, 'baseline.json');

/** One query's outcome: the raw result positions, as keys, in rank order. */
export type QueryOutcome = { query: GoldenQuery; ranked: string[] };

const scoreQuery = (args: { outcome: QueryOutcome }): QueryRow => {
  const expected = args.outcome.query.expected.map((expectation) => {
    return expectation.key;
  });
  const ranked = args.outcome.ranked;

  const recallAt5 = recallAtK({ expected, ranked, k: 5 });
  const recallAt10 = recallAtK({ expected, ranked, k: 10 });

  return {
    id: args.outcome.query.id,
    kind: args.outcome.query.kind,
    first_relevant_rank: firstRelevantRank({ expected, ranked }),
    hit_at_5: recallAt5 > 0,
    hit_at_10: recallAt10 > 0,
    recall_at_5: roundMetric(recallAt5),
    recall_at_10: roundMetric(recallAt10),
  };
};

const aggregate = (args: { rows: QueryRow[] }): Metrics => {
  if (args.rows.length === 0) {
    return { recall_at_5: 0, recall_at_10: 0, mrr: 0 };
  }
  const mean = (pick: (row: QueryRow) => number): number => {
    const total = args.rows.reduce((sum, row) => {
      return sum + pick(row);
    }, 0);
    return roundMetric(total / args.rows.length);
  };
  return {
    recall_at_5: mean((row) => {
      return row.recall_at_5;
    }),
    recall_at_10: mean((row) => {
      return row.recall_at_10;
    }),
    mrr: roundMetric(
      meanReciprocalRank({
        ranks: args.rows.map((row) => {
          return row.first_relevant_rank;
        }),
      })
    ),
  };
};

export const buildReport = (args: {
  version: number;
  outcomes: QueryOutcome[];
}): Report => {
  const rows = args.outcomes.map((outcome) => {
    return scoreQuery({ outcome });
  });

  const kinds = [
    ...new Set(
      rows.map((row) => {
        return String(row.kind);
      })
    ),
  ].sort();

  const byKind: Record<string, Metrics> = {};
  for (const kind of kinds) {
    byKind[kind] = aggregate({
      rows: rows.filter((row) => {
        return row.kind === kind;
      }),
    });
  }

  return {
    version: args.version,
    metrics: aggregate({ rows }),
    // `by_kind` is what shows a lexical win: a global recall number averages
    // the exact-token queries away against the semantic ones.
    by_kind: byKind,
    queries: rows,
  };
};

const serialize = (args: { report: Report }): string => {
  return `${JSON.stringify(args.report, null, 2)}\n`;
};

export const writeReport = (args: { report: Report; file: string }) => {
  writeFileSync(args.file, serialize({ report: args.report }));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readMetrics = (args: { value: unknown; field: string }): Metrics => {
  const value = args.value;
  if (!isRecord(value)) {
    throw new Error(`baseline.json: ${args.field} must be an object`);
  }
  const read = (key: keyof Metrics): number => {
    const metric = value[key];
    if (typeof metric !== 'number' || !Number.isFinite(metric)) {
      throw new Error(`baseline.json: ${args.field}.${key} must be a number`);
    }
    return metric;
  };
  return {
    recall_at_5: read('recall_at_5'),
    recall_at_10: read('recall_at_10'),
    mrr: read('mrr'),
  };
};

/**
 * Reads a committed baseline. Only the fields the gate compares are validated:
 * the per-query rows are there for a human reading the diff, and a stricter
 * parse would turn a report-shape addition into a failure to load the baseline
 * at all.
 */
export const parseReport = (args: { raw: unknown }): Report => {
  if (!isRecord(args.raw)) {
    throw new Error('baseline.json: the document must be an object');
  }
  if (typeof args.raw.version !== 'number') {
    throw new Error('baseline.json: version must be a number');
  }
  if (!isRecord(args.raw.by_kind)) {
    throw new Error('baseline.json: by_kind must be an object');
  }
  const byKind: Record<string, Metrics> = {};
  for (const [kind, value] of Object.entries(args.raw.by_kind)) {
    byKind[kind] = readMetrics({ value, field: `by_kind.${kind}` });
  }
  return {
    version: args.raw.version,
    metrics: readMetrics({ value: args.raw.metrics, field: 'metrics' }),
    by_kind: byKind,
    queries: [],
  };
};

export const readBaseline = (): Report | null => {
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    return parseReport({ raw: JSON.parse(raw) });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
};

/**
 * The metrics the gate refuses a drop in.
 *
 * recall@10 alone cannot gate a ranking change that only ever *demotes* a
 * result — the recency blend is one: a relevant entry it pushes from rank 1 to
 * rank 2 is still retrieved, so recall cannot move, and the whole effect is
 * invisible. Position is what MRR measures, which is why both are compared.
 *
 * recall@5 is reported but not gated: it is recall@10 read at a tighter cutoff,
 * and gating it would refuse a change that moves a result from rank 5 to rank 6
 * while MRR and recall@10 both improve.
 */
const GATED_METRICS = ['recall_at_10', 'mrr'] as const;

type GatedMetric = (typeof GATED_METRICS)[number];

export type RegressionFailure = {
  scope: string;
  metric: GatedMetric;
  baseline: number;
  current: number;
};

const compareMetrics = (args: {
  scope: string;
  baseline: Metrics;
  /** `undefined` where this run did not score the scope at all. */
  current: Metrics | undefined;
}): RegressionFailure[] => {
  return GATED_METRICS.flatMap((metric) => {
    const baseline = args.baseline[metric];
    const current = args.current?.[metric] ?? 0;
    if (current >= baseline) return [];
    return [{ scope: args.scope, metric, baseline, current }];
  });
};

/**
 * Zero tolerance on every {@link GATED_METRICS} entry, globally and per kind.
 * Per kind matters as much as the global number: a change that trades every
 * exact-token hit for a semantic one can leave the global figure untouched.
 */
export const findRegressions = (args: {
  report: Report;
  baseline: Report;
}): RegressionFailure[] => {
  const failures = compareMetrics({
    scope: 'overall',
    baseline: args.baseline.metrics,
    current: args.report.metrics,
  });

  for (const [kind, metrics] of Object.entries(args.baseline.by_kind)) {
    const current = args.report.by_kind[kind];
    failures.push(
      ...compareMetrics({
        // A kind the baseline scores and the report does not means the golden
        // set lost those queries — never a pass.
        scope: current === undefined ? `${kind} (absent from this run)` : kind,
        baseline: metrics,
        current,
      })
    );
  }

  return failures;
};

const formatMetric = (value: number): string => {
  return value.toFixed(4).padStart(8);
};

const formatRow = (args: { scope: string; metrics: Metrics }): string => {
  return [
    args.scope.padEnd(14),
    formatMetric(args.metrics.recall_at_5),
    formatMetric(args.metrics.recall_at_10),
    formatMetric(args.metrics.mrr),
  ].join('  ');
};

/**
 * The stdout table. Written through `process.stdout` rather than `console`: it
 * is the command's output, not a debug log, and the suite mutes `console`.
 */
export const printReport = (args: {
  report: Report;
  write: (text: string) => void;
}) => {
  const header = [
    'scope'.padEnd(14),
    'recall@5'.padStart(8),
    'recall@10'.padStart(8),
    'mrr'.padStart(8),
  ].join('  ');

  const lines = [
    '',
    `knowledge retrieval eval — golden set v${args.report.version}, ${args.report.queries.length} queries`,
    '',
    header,
    '-'.repeat(header.length),
    formatRow({ scope: 'overall', metrics: args.report.metrics }),
  ];

  for (const [kind, metrics] of Object.entries(args.report.by_kind)) {
    lines.push(formatRow({ scope: kind, metrics }));
  }

  lines.push('');

  args.write(`${lines.join('\n')}\n`);
};
