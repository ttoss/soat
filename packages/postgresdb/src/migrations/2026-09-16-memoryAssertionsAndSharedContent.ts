import { defineMigration } from '@ttoss/postgresdb';

import { getEmbeddingDimensions } from '../utils/embedding';

/**
 * The text a memory holds moves to a row of its own, one per distinct text per
 * store, shared by that memory and by every assertion that ever stated it.
 *
 * The hash must match `hashMemoryContent` in the server: sha256 of the content
 * trimmed and whitespace-collapsed. `regexp_replace(…, '\s+', ' ', 'g')` is
 * that collapse, and `digest` needs pgcrypto.
 *
 * `DISTINCT ON` collapses identical texts in one store to a single row, which
 * the unique index requires and which is the point of sharing the row at all:
 * the vector is stored once instead of once per copy. The oldest row wins where
 * copies disagree, because an older vector was produced by the model the rest of
 * the corpus was embedded with, so distances stay comparable.
 */
const NORMALIZED_HASH = `encode(digest(regexp_replace(btrim(m.content), '\\s+', ' ', 'g'), 'sha256'), 'hex')`;

const contentTableSql = (dimensions: number) => {
  return `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS memory_contents (
      id              serial PRIMARY KEY,
      memory_store_id integer NOT NULL REFERENCES memory_stores (id) ON DELETE CASCADE,
      content         text NOT NULL,
      content_hash    varchar(64) NOT NULL,
      embedding       vector(${dimensions}),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS memory_contents_store_hash_unique
      ON memory_contents (memory_store_id, content_hash);

    INSERT INTO memory_contents (memory_store_id, content, content_hash, embedding)
    SELECT DISTINCT ON (m.memory_store_id, ${NORMALIZED_HASH})
           m.memory_store_id, m.content, ${NORMALIZED_HASH}, m.embedding
      FROM memories m
     ORDER BY m.memory_store_id, ${NORMALIZED_HASH}, m.created_at ASC
        ON CONFLICT (memory_store_id, content_hash) DO NOTHING;
  `;
};

/**
 * `memories` points at the shared row and stops carrying the text itself.
 *
 * Dropping `embedding` takes `memories_embedding_hnsw_idx` with it. No
 * `context.sync()` here: every index this leaves missing — the HNSW one over
 * `memory_contents.embedding`, and `memories_content_id_idx` — is one the
 * models declare, so the sync that follows the migrations builds them, and it
 * meets a `memories` that has already shed the columns it must not index.
 */
const POINT_AT_CONTENT_SQL = `
  UPDATE memories m
     SET content_id = mc.id
    FROM memory_contents mc
   WHERE m.content_id IS NULL
     AND mc.memory_store_id = m.memory_store_id
     AND mc.content_hash = ${NORMALIZED_HASH};
`;

/**
 * The assertion ledger, created empty. Historical writes cannot be
 * reconstructed — a skip left no row and a merge left no trace, which is the
 * problem this change fixes, not a gap here.
 *
 * `rule_id` is a plain integer, not a foreign key: `memory_rules` does not
 * exist yet (#1324 adds the table, the constraint, and the values). Null means
 * the built-in extractor.
 */
const ASSERTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS memory_assertions (
    id              serial PRIMARY KEY,
    public_id       varchar(32) NOT NULL,
    memory_store_id integer NOT NULL REFERENCES memory_stores (id) ON DELETE CASCADE,
    content_id      integer NOT NULL REFERENCES memory_contents (id) ON DELETE CASCADE,
    memory_id       integer REFERENCES memories (id) ON DELETE SET NULL,
    generation_id   integer REFERENCES generations (id) ON DELETE SET NULL,
    mechanism       varchar(16) NOT NULL,
    rule_id         integer,
    principal_type  varchar(255) NOT NULL,
    principal_id    varchar(255) NOT NULL,
    outcome         varchar(16) NOT NULL,
    similarity      double precision,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS memory_assertions_public_id_unique
    ON memory_assertions (public_id);
  CREATE INDEX IF NOT EXISTS memory_assertions_memory_store_id_created_at_idx
    ON memory_assertions (memory_store_id, created_at);
  CREATE INDEX IF NOT EXISTS memory_assertions_memory_id_idx
    ON memory_assertions (memory_id);
  CREATE INDEX IF NOT EXISTS memory_assertions_generation_id_idx
    ON memory_assertions (generation_id);
`;

export const memoryAssertionsAndSharedContent = defineMigration({
  name: '2026-09-16-memory-assertions-and-shared-content',
  description:
    'memories.content/embedding move to a shared memory_contents row, memory_assertions records every write, and generations.conversation_id plus the memory_stores threshold pair are added.',
  /**
   * The runner probes every pending migration **before running any of them**,
   * so this answers for the database as it stands now, not as the rename
   * before it will leave it. Three states have to come apart:
   *
   * - A database still holding `memory_entries` has not been renamed yet. Its
   *   `memories` is the *container* and has no `content` column, which would
   *   read as "already applied" on the column test alone — and silently skip
   *   this migration for exactly the databases that need it. Hence the first
   *   probe, in the previous migration's vocabulary.
   * - A database `sync` has just built has no `memories.content` and never had
   *   one, so it records this rather than replaying it against empty tables.
   *   That is what keeps a new install from needing an operator `baseline`.
   * - Anything else with `memories.content` still there is the real work.
   */
  isApplied: async (context) => {
    if (await context.tableExists({ table: 'memory_entries' })) {
      return false;
    }

    return !(await context.columnExists({
      table: 'memories',
      column: 'content',
    }));
  },
  up: async (context) => {
    context.say('collecting the distinct memory texts into memory_contents');

    // One multi-statement string per step: Postgres runs the commands of a
    // simple query in one implicit transaction, so a failure cannot leave the
    // content table built and the rows uncopied. Separate `run` calls would
    // lose that — they can land on different pooled connections.
    await context.run({ sql: contentTableSql(getEmbeddingDimensions()) });

    await context.addColumnIfMissing({
      table: 'memories',
      column: 'content_id',
      type: 'integer REFERENCES memory_contents (id) ON DELETE CASCADE',
    });

    context.say('pointing each memory at its shared content row');
    await context.run({ sql: POINT_AT_CONTENT_SQL });
    await context.setNotNull({ table: 'memories', column: 'content_id' });

    context.say('dropping the per-memory text and vector');
    await context.dropColumnIfExists({
      table: 'memories',
      column: 'embedding',
    });
    await context.dropColumnIfExists({ table: 'memories', column: 'content' });

    context.say('creating the assertion ledger');
    await context.run({ sql: ASSERTIONS_SQL });
  },
});
