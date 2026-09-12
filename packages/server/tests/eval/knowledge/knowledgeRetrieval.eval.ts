import type { KnowledgeResult } from 'src/lib/knowledge';
import { searchKnowledge } from 'src/lib/knowledge';

import { shouldUpdateBaseline } from '../updateBaseline';
import type { GoldenSet } from './goldenSet';
import { loadGoldenSet } from './goldenSet';
import type { QueryOutcome, Report } from './report';
import {
  BASELINE_PATH,
  buildReport,
  findRegressions,
  printReport,
  readBaseline,
  REPORT_PATH,
  RESULT_LIMIT,
  writeReport,
} from './report';
import type { SeededCorpus } from './seedCorpus';
import { CORPUS_TAGS, seedGoldenCorpus } from './seedCorpus';

/**
 * The regression gate for every knowledge ranking change.
 *
 * Seeds the golden corpus, runs every labeled query through `searchKnowledge`,
 * scores recall@5, recall@10 and MRR globally and per query kind, writes the
 * report, and fails when recall@10 falls below the committed baseline.
 *
 *   pnpm --filter @soat/server eval:knowledge
 *   pnpm --filter @soat/server eval:knowledge --update-baseline
 */

const resolveKey = (args: {
  result: KnowledgeResult;
  corpus: SeededCorpus;
}): string => {
  const key =
    args.result.source_type === 'document'
      ? args.corpus.documentKeys.get(args.result.document_id)
      : args.corpus.memoryEntryKeys.get(args.result.entry_id);

  if (key === undefined) {
    // Every row the search can reach was seeded by this run, so an unknown one
    // means the corpus filter leaked and the ranking is being scored against
    // something the golden set never labeled.
    throw new Error(
      `eval: a ${args.result.source_type} result outside the seeded corpus was returned`
    );
  }

  return key;
};

const runGoldenQueries = async (args: {
  golden: GoldenSet;
  corpus: SeededCorpus;
}): Promise<QueryOutcome[]> => {
  const outcomes: QueryOutcome[] = [];

  for (const query of args.golden.queries) {
    const results = await searchKnowledge({
      projectIds: [args.corpus.projectId],
      billingProjectId: args.corpus.projectId,
      query: query.query,
      tags: CORPUS_TAGS,
      limit: RESULT_LIMIT,
    });

    outcomes.push({
      query,
      // Raw result positions, never deduplicated by key: a document occupying
      // five slots is exactly what the caller experiences.
      ranked: results.map((result) => {
        return resolveKey({ result, corpus: args.corpus });
      }),
    });
  }

  return outcomes;
};

describe('knowledge retrieval golden set', () => {
  const golden = loadGoldenSet();
  let report: Report;

  beforeAll(async () => {
    const corpus = await seedGoldenCorpus({ golden });
    const outcomes = await runGoldenQueries({ golden, corpus });
    report = buildReport({ version: golden.version, outcomes });

    writeReport({ report, file: REPORT_PATH });
    if (shouldUpdateBaseline()) {
      writeReport({ report, file: BASELINE_PATH });
    }

    printReport({
      report,
      write: (text) => {
        process.stdout.write(text);
      },
    });
  });

  test('scores every labeled query', () => {
    expect(report.queries).toHaveLength(golden.queries.length);
  });

  test('reports recall@5, recall@10 and MRR for every query kind', () => {
    const kinds = new Set(
      golden.queries.map((query) => {
        return String(query.kind);
      })
    );
    expect(Object.keys(report.by_kind).sort()).toEqual([...kinds].sort());
  });

  test('does not regress against the committed baseline', () => {
    const baseline = readBaseline();

    if (shouldUpdateBaseline()) {
      expect(baseline).not.toBeNull();
      return;
    }

    if (baseline === null) {
      throw new Error(
        `no baseline at ${BASELINE_PATH}. Run \`pnpm --filter @soat/server eval:knowledge --update-baseline\` and commit it.`
      );
    }

    const regressions = findRegressions({ report, baseline });

    // The message carries the numbers: a ranking PR reads its own regression
    // out of the failure instead of re-running the eval to find out.
    expect(
      regressions.map((failure) => {
        return `${failure.scope}: recall@10 ${failure.current} < baseline ${failure.baseline}`;
      })
    ).toEqual([]);
  });
});
