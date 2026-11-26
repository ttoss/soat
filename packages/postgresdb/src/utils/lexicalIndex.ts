import { Sequelize } from '@ttoss/postgresdb';

/**
 * Knowledge search's lexical channel matches `to_tsvector(<config>, content)`,
 * and every table it searches carries a GIN index over that expression. The
 * planner uses the index only when the query's expression and predicate are
 * these verbatim, so the server builds its match from the same constants.
 */

/** The text search configuration the index is built under. */
export const LEXICAL_INDEX_TEXT_SEARCH_CONFIG = 'simple';

/**
 * Texts longer than this are neither indexed nor lexically matched:
 * `to_tsvector` raises past 1 MB of lexemes, which would fail the write that
 * stores the text. Half the limit leaves room for lowercasing to grow it.
 */
export const LEXICAL_MAX_CONTENT_BYTES = 524288;

type Literal = ReturnType<typeof Sequelize.literal>;

/** The GIN index a lexically searched `content` column carries. */
export const lexicalContentIndex = (args: {
  table: string;
}): { name: string; using: string; fields: Literal[]; where: Literal } => {
  return {
    name: `${args.table}_content_lexical_gin_idx`,
    using: 'gin',
    fields: [
      Sequelize.literal(
        `to_tsvector('${LEXICAL_INDEX_TEXT_SEARCH_CONFIG}'::regconfig, content)`
      ),
    ],
    where: Sequelize.literal(
      `octet_length(content) <= ${LEXICAL_MAX_CONTENT_BYTES}`
    ),
  };
};
