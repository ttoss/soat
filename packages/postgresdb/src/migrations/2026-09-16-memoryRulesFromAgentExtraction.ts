import { defineMigration } from '@ttoss/postgresdb';

/**
 * Extraction stops being an agent setting and becomes a rule on the memory
 * store it writes into.
 *
 * `sync` cannot do this: the rows come from a JSONB field it does not read, the
 * foreign key lands on a `memory_assertions` column that already exists, and
 * the `extraction` key has to be taken back out of every agent's bag.
 */
const MEMORY_RULES_SQL = `
  CREATE TABLE IF NOT EXISTS memory_rules (
    id                serial PRIMARY KEY,
    public_id         varchar(32) NOT NULL,
    memory_store_id   integer NOT NULL REFERENCES memory_stores (id) ON DELETE CASCADE,
    "on"              varchar(64) NOT NULL,
    source_agent_ids  jsonb,
    agent_id          integer REFERENCES agents (id) ON DELETE RESTRICT,
    tool_id           integer REFERENCES tools (id) ON DELETE RESTRICT,
    action            varchar(255),
    preset_parameters jsonb,
    prompt            text,
    ai_provider_id    integer REFERENCES ai_providers (id) ON DELETE SET NULL,
    model             varchar(255),
    enabled           boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS memory_rules_public_id_unique
    ON memory_rules (public_id);
  CREATE INDEX IF NOT EXISTS memory_rules_memory_store_id_idx
    ON memory_rules (memory_store_id);
`;

/**
 * The constraint #1322 could not add, because the table it points at did not
 * exist yet. `SET NULL`, like every other key on the ledger: deleting a rule
 * must not erase the writes it made.
 */
export const ASSERTION_RULE_FK = 'memory_assertions_rule_id_fkey';

const ASSERTION_FK_SQL = `
  CREATE INDEX IF NOT EXISTS memory_assertions_rule_id_idx
    ON memory_assertions (rule_id);

  ALTER TABLE memory_assertions
    ADD CONSTRAINT ${ASSERTION_RULE_FK}
    FOREIGN KEY (rule_id) REFERENCES memory_rules (id) ON DELETE SET NULL;
`;

/**
 * A 16-character `[A-Za-z0-9]` id, matching `generatePublicId`: 12 random bytes
 * are exactly 16 base64 characters, and the two non-alphanumeric ones are
 * mapped onto letters. `gen_random_bytes` needs pgcrypto, which the assertion
 * migration before this one already enables.
 */
const PUBLIC_ID = `'mrule_' || translate(encode(gen_random_bytes(12), 'base64'), '+/', 'Az')`;

/**
 * `extraction` was `true` or an object that did not say `enabled: false`, and
 * it did nothing at all without a `write_memory_store_id` — so only that pair
 * becomes a rule. The `ExtractionConfig` overrides move across field for field.
 *
 * The `NOT EXISTS` guard is what makes a retry safe: the ledger records what
 * finished, so an attempt that inserted the rows and then failed before
 * stripping the bags is replayed from the top.
 */
const BACKFILL_SQL = `
  INSERT INTO memory_rules (
    public_id, memory_store_id, "on", source_agent_ids,
    prompt, ai_provider_id, model, enabled
  )
  SELECT ${PUBLIC_ID},
         ms.id,
         'agents.generation.completed',
         jsonb_build_array(a.public_id),
         CASE WHEN jsonb_typeof(a.knowledge_config -> 'extraction') = 'object'
              THEN a.knowledge_config -> 'extraction' ->> 'prompt' END,
         aip.id,
         CASE WHEN jsonb_typeof(a.knowledge_config -> 'extraction') = 'object'
              THEN a.knowledge_config -> 'extraction' ->> 'model' END,
         true
    FROM agents a
    JOIN memory_stores ms
      ON ms.public_id = a.knowledge_config ->> 'write_memory_store_id'
    LEFT JOIN ai_providers aip
      ON jsonb_typeof(a.knowledge_config -> 'extraction') = 'object'
     AND aip.public_id = a.knowledge_config -> 'extraction' ->> 'ai_provider_id'
   WHERE (
           a.knowledge_config -> 'extraction' = 'true'::jsonb
           OR (
             jsonb_typeof(a.knowledge_config -> 'extraction') = 'object'
             AND coalesce(a.knowledge_config -> 'extraction' ->> 'enabled', 'true') <> 'false'
           )
         )
     AND NOT EXISTS (
           SELECT 1 FROM memory_rules mr
            WHERE mr.memory_store_id = ms.id
              AND mr.source_agent_ids = jsonb_build_array(a.public_id)
         );
`;

/**
 * The field itself goes. Per the standing no-shim rule, an agent that keeps
 * sending `extraction` now gets a `400` from `strictFields`, rather than a
 * setting that is accepted and quietly ignored.
 *
 * Agent versions are rewritten too: a version is the config a canary or a
 * rollback is served from, so one still carrying `extraction` would put the
 * retired field back into a live turn's resolved config.
 */
const STRIP_EXTRACTION_SQL = `
  UPDATE agents
     SET knowledge_config = knowledge_config - 'extraction'
   WHERE knowledge_config ? 'extraction';

  UPDATE agent_versions
     SET config = jsonb_set(
           config,
           '{knowledge_config}',
           (config -> 'knowledge_config') - 'extraction'
         )
   WHERE config -> 'knowledge_config' ? 'extraction';
`;

const constraintExists = async (args: {
  select: <T>(a: { sql: string }) => Promise<T[]>;
}): Promise<boolean> => {
  const rows = await args.select<{ count: string }>({
    sql: `SELECT count(*) AS count FROM pg_constraint WHERE conname = '${ASSERTION_RULE_FK}'`,
  });
  return Number(rows[0]?.count ?? 0) > 0;
};

export const memoryRulesFromAgentExtraction = defineMigration({
  name: '2026-09-16-memory-rules-from-agent-extraction',
  description:
    'memory_rules is added and owned by the memory store, memory_assertions.rule_id becomes a foreign key into it, and every agent with knowledge_config.extraction becomes one rule before the field is stripped.',
  /**
   * Two states have to come apart, and both are read off the schema:
   *
   * - A database `sync` will build from the models — there is no `agents` table
   *   yet, because the migrations run *before* the sync. Nothing to move, and
   *   the sync that follows creates `memory_rules` with the key already on it,
   *   so this is recorded rather than replayed. That is what keeps a new
   *   install from needing an operator `baseline`.
   * - Anything else: the constraint is the migration's own signature. It is
   *   added in the same run as the rows and the strip, and `sync` never adds it
   *   to a `memory_assertions` that already exists.
   */
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'agents' }))) {
      return true;
    }
    return constraintExists(context);
  },
  up: async (context) => {
    context.say('creating memory_rules');
    await context.run({ sql: MEMORY_RULES_SQL });

    if (!(await constraintExists(context))) {
      context.say('pointing memory_assertions.rule_id at it');
      await context.run({ sql: ASSERTION_FK_SQL });
    }

    context.say('turning every agent-side extraction config into a rule');
    await context.run({ sql: BACKFILL_SQL });

    context.say('removing knowledge_config.extraction');
    await context.run({ sql: STRIP_EXTRACTION_SQL });
  },
});
