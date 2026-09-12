import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:knowledge');

/**
 * The lexical half of hybrid retrieval: a PostgreSQL full-text query run beside
 * the pgvector one, over the same `content` column and under the same scope
 * filters.
 *
 * Both `content` columns are plain `TEXT`, so this needs no schema change and
 * no index — `to_tsvector` is computed per candidate row. Promotion to a stored
 * `tsvector` column with a GIN index is a measured decision, not a default; the
 * condition is written down in `knowledge.md`.
 */

/** Text search configuration when the deployment names none. */
export const DEFAULT_TEXT_SEARCH_CONFIG = 'simple';

/**
 * The `regconfig` both `to_tsvector` and `websearch_to_tsquery` run under.
 *
 * `simple` removes no stopwords and does no stemming, and
 * `websearch_to_tsquery` ANDs the terms it produces — so a natural-language
 * question almost never matches lexically, and this channel is an **exact-token
 * and exact-phrase** one: identifiers, error codes, names, SKUs. That is the
 * intended split, with the vector channel carrying everything else.
 * `KNOWLEDGE_TEXT_SEARCH_CONFIG` trades it for a language-specific config where
 * the deployment's language mix is known.
 */
export const getTextSearchConfig = (): string => {
  return process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG || DEFAULT_TEXT_SEARCH_CONFIG;
};

/**
 * Both fragments pass the config name and the query text as **values**, so
 * Sequelize escapes them; neither is spliced into a literal the way the
 * embedding vector is. `websearch_to_tsquery` never raises on malformed input,
 * but the string is caller-supplied and must not reach SQL unescaped for that
 * reason alone.
 */
const contentTsVector = (args: { column: string }) => {
  return db.sequelize.fn(
    'to_tsvector',
    getTextSearchConfig(),
    db.sequelize.col(args.column)
  );
};

const queryTsQuery = (args: { query: string }) => {
  return db.sequelize.fn(
    'websearch_to_tsquery',
    getTextSearchConfig(),
    args.query
  );
};

/** Matches rows whose `content` satisfies every term the query produced. */
export const lexicalMatchWhere = (args: { column: string; query: string }) => {
  return db.sequelize.where(
    contentTsVector({ column: args.column }),
    '@@',
    queryTsQuery({ query: args.query })
  );
};

/**
 * Cover-density rank, for `ORDER BY … DESC`. `ts_rank_cd` rewards matches that
 * sit close together, which separates a chunk discussing the terms from one
 * that happens to contain them in unrelated places.
 */
export const lexicalRankExpression = (args: {
  column: string;
  query: string;
}) => {
  return db.sequelize.fn(
    'ts_rank_cd',
    contentTsVector({ column: args.column }),
    queryTsQuery({ query: args.query })
  );
};

/**
 * Runs a lexical candidate query, degrading to no lexical channel at all when
 * it fails.
 *
 * The vector query is the one that always has an answer; lexical is additive,
 * so a misconfigured `KNOWLEDGE_TEXT_SEARCH_CONFIG` — the one realistic failure
 * — costs exact-token recall rather than the whole search.
 */
export const withLexicalDegrade = async <T>(args: {
  source: 'documents' | 'memoryEntries';
  run: () => Promise<T[]>;
}): Promise<T[]> => {
  try {
    return await args.run();
  } catch (error) {
    log(
      'withLexicalDegrade: lexical query over %s failed, degrading to vector-only: %o',
      args.source,
      error
    );
    return [];
  }
};
