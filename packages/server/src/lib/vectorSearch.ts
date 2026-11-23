import { db } from '../db';
import type { Transaction } from './dbTransaction';
import { timeoutFromEnv, withStatementTimeout } from './statementTimeout';

/**
 * Statement timeout of every knowledge and memory search query. A search that
 * outruns it ends as `QUERY_TIMEOUT` instead of holding its connection, and the
 * caller's gateway, for minutes.
 */
const searchTimeoutMs = (): number => {
  return timeoutFromEnv({ env: 'KNOWLEDGE_QUERY_TIMEOUT_MS', fallback: 30000 });
};

/** Runs one search query under the search statement timeout. */
export const withBoundedSearch = async <T>(args: {
  run: (options: { transaction: Transaction }) => Promise<T>;
}): Promise<T> => {
  const timeoutMs = searchTimeoutMs();
  return withStatementTimeout({
    timeoutMs,
    message: `The search ran past ${timeoutMs} ms. Narrow it with \`document_paths\`, \`memory_store_ids\` or \`tags\`, or lower \`limit\`.`,
    run: args.run,
  });
};

/**
 * Runs a vector search with pgvector's iterative index scan enabled.
 *
 * An HNSW index answers `ORDER BY embedding <=> $query LIMIT n` from its graph,
 * and yields those `ef_search` candidates *before* the query's own filters run.
 * Every semantic search here filters after the ordering — document chunks
 * through a required join to `files.project_id`, memories through
 * `memory_store_id` and `invalidated_at` — so a selective scope can discard the whole
 * candidate list and return short, or empty, while matching rows sit further
 * down the graph. Nothing errors; recall just collapses. An iterative
 * scan keeps widening the search until the limit is satisfied after filtering.
 *
 * `strict_order`, not `relaxed_order`: the knowledge and memories contracts
 * make the ordering of `score` the guarantee, and the relaxed mode returns rows
 * slightly out of distance order.
 *
 * The setting is session-scoped, so it has to be `SET LOCAL` inside a
 * transaction — a plain `SET` would leak onto a pooled connection, and
 * `@ttoss/postgresdb` exposes no per-connection hook to set it once. Requires
 * pgvector 0.8 or newer. The query runs under the search statement timeout
 * (`withBoundedSearch`).
 */
export const withIterativeVectorScan = async <T>(args: {
  run: (options: { transaction: Transaction }) => Promise<T>;
}): Promise<T> => {
  return withBoundedSearch({
    run: async ({ transaction }) => {
      await db.sequelize.query(
        "SET LOCAL hnsw.iterative_scan = 'strict_order'",
        { transaction }
      );
      return args.run({ transaction });
    },
  });
};
