import {
  LEXICAL_INDEX_TEXT_SEARCH_CONFIG,
  LEXICAL_MAX_CONTENT_BYTES,
} from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import type { Transaction } from './dbTransaction';
import { loggableError } from './loggableError';
import { withBoundedSearch } from './vectorSearch';

const log = createDebug('soat:knowledge');

/**
 * Sequelize's own fragment types, named through `db` rather than imported.
 * `@ttoss/postgresdb` re-exports neither, and letting them be inferred makes
 * the declaration name a path inside `.pnpm/sequelize@…` (TS2883).
 */
type SequelizeWhere = ReturnType<typeof db.sequelize.where>;
type SequelizeFn = ReturnType<typeof db.sequelize.fn>;

/**
 * The lexical half of hybrid retrieval: a PostgreSQL full-text query run beside
 * the pgvector one, over the same `content` column and under the same scope
 * filters.
 *
 * Each searched table carries a GIN index over `to_tsvector('simple', content)`
 * (`lexicalContentIndex` in `@soat/postgresdb`), which the planner uses only
 * while the match below is that expression and that predicate verbatim. Under
 * any other `KNOWLEDGE_TEXT_SEARCH_CONFIG` the match is the same and unindexed:
 * every search re-tokenizes every row of the table.
 */

/** Text search configuration when the deployment names none. */
export const DEFAULT_TEXT_SEARCH_CONFIG = LEXICAL_INDEX_TEXT_SEARCH_CONFIG;

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
const contentTsVector = (args: { column: string }): SequelizeFn => {
  return db.sequelize.fn(
    'to_tsvector',
    getTextSearchConfig(),
    db.sequelize.col(args.column)
  );
};

const queryTsQuery = (args: { query: string }): SequelizeFn => {
  return db.sequelize.fn(
    'websearch_to_tsquery',
    getTextSearchConfig(),
    args.query
  );
};

/**
 * Matches rows whose `content` satisfies every term the query produced. A text
 * past `LEXICAL_MAX_CONTENT_BYTES` is never a lexical candidate: the index
 * leaves it out, and `to_tsvector` can raise on it.
 */
export const lexicalMatchWhere = (args: {
  column: string;
  query: string;
}): { [Op.and]: SequelizeWhere[] } => {
  return {
    [Op.and]: [
      db.sequelize.where(
        contentTsVector({ column: args.column }),
        '@@',
        queryTsQuery({ query: args.query })
      ),
      db.sequelize.where(
        db.sequelize.fn('octet_length', db.sequelize.literal(args.column)),
        { [Op.lte]: LEXICAL_MAX_CONTENT_BYTES }
      ),
    ],
  };
};

/**
 * Cover-density rank, for `ORDER BY … DESC`. `ts_rank_cd` rewards matches that
 * sit close together, which separates a chunk discussing the terms from one
 * that happens to contain them in unrelated places.
 */
export const lexicalRankExpression = (args: {
  column: string;
  query: string;
}): SequelizeFn => {
  return db.sequelize.fn(
    'ts_rank_cd',
    contentTsVector({ column: args.column }),
    queryTsQuery({ query: args.query })
  );
};

/**
 * Runs a lexical candidate query under the search statement timeout, degrading
 * to no lexical channel at all when it fails.
 *
 * The vector query is the one that always has an answer; lexical is additive,
 * so a misconfigured `KNOWLEDGE_TEXT_SEARCH_CONFIG` or a lexical query past the
 * timeout costs exact-token recall rather than the whole search.
 */
export const withLexicalDegrade = async <T>(args: {
  source: 'documents' | 'memories';
  run: (options: { transaction: Transaction }) => Promise<T[]>;
}): Promise<T[]> => {
  try {
    return await withBoundedSearch({ run: args.run });
  } catch (error) {
    log(
      'withLexicalDegrade: lexical query over %s failed, degrading to vector-only: %o',
      args.source,
      loggableError(error)
    );
    return [];
  }
};
