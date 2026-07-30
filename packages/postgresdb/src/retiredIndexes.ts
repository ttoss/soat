/**
 * Index and constraint names that the models **used to** declare and no longer
 * do — the teardown step `sync({ alter: true })` cannot express.
 *
 * `sync({ alter: true })` reconciles indexes additively: it creates what the
 * models declare and is missing from the catalog, and it never drops a catalog
 * object it does not recognize. So every index *rename* leaves the old name
 * behind permanently, in every database the schema has ever been synced
 * against. Two failure modes follow, and both have been observed in production:
 *
 * - **Wasted space.** The same columns end up indexed two or three times under
 *   different names, one per naming generation.
 * - **A stale grain, silently enforced.** When a rename *widened* a unique
 *   index, the narrower predecessor survives and keeps rejecting rows the new
 *   index is meant to allow — citing an index name that appears nowhere in the
 *   codebase. `price_books` (below) is exactly this.
 *
 * Listing a name here makes the drop happen: `dropRetiredIndexes` runs at boot
 * and removes each one idempotently, so every environment converges — not just
 * the databases someone remembered to clean by hand.
 *
 * ## Adding a name
 *
 * When you rename or remove an index, add its **previous** name here in the
 * same change. `schemaDrift.test.ts` fails if a name in this list is still
 * declared by a model, so the list can never drop a live index.
 *
 * Names are grouped by the naming generation that produced them.
 *
 * @module
 */
import type { Sequelize } from '@ttoss/postgresdb';

/**
 * The transaction handle `sequelize.query` accepts.
 *
 * `@ttoss/postgresdb` re-exports `Sequelize` but not Sequelize's `Transaction`
 * type, and `sequelize` itself is not a direct dependency of this package —
 * importing from it would reach through the dependency graph. Reading the type
 * off the method that consumes it keeps the reference first-hand.
 */
type QueryTransaction = NonNullable<
  Parameters<Sequelize['query']>[1]
>['transaction'];

/**
 * Generation 1 — `<table>_<column>_key`.
 *
 * Postgres's own name for the constraint created by a bare column-level
 * `UNIQUE` in the column DDL, which is what `@Column({ unique: true })` emitted
 * before #710 replaced all 58 of them with named index entries. Sequelize
 * cannot match these against a model, so each one was re-added on every
 * `sync({ alter: true })` (index count grew 150 → 205 → 260 across three
 * passes, accruing `_key1`, `_key2`, … until a name collision would crash boot
 * with 42P07).
 *
 * Postgres's collision-suffixed variants (`_key1`, `_key2`, …) are **not**
 * listed: the suffix is unbounded, so enumerating them is guesswork. The drift
 * check reports anything left over.
 */
const GENERATION_1_COLUMN_UNIQUE_NAMES = [
  'activity_entries_public_id_key',
  'actors_public_id_key',
  'agents_public_id_key',
  'ai_providers_public_id_key',
  'api_keys_public_id_key',
  'approval_items_dedup_key_key',
  'approval_items_public_id_key',
  'audit_entries_public_id_key',
  'chats_public_id_key',
  'conversations_public_id_key',
  'discussion_participants_public_id_key',
  'discussion_runs_public_id_key',
  'discussions_public_id_key',
  'document_chunks_public_id_key',
  'documents_file_id_key',
  'documents_public_id_key',
  'exception_items_dedup_key_key',
  'exception_items_public_id_key',
  'files_public_id_key',
  'formation_operations_public_id_key',
  'formation_resources_public_id_key',
  'formations_public_id_key',
  'generations_public_id_key',
  'guardrail_evaluations_public_id_key',
  'guardrail_versions_public_id_key',
  'guardrails_public_id_key',
  'ingestion_rules_public_id_key',
  'memories_public_id_key',
  'memory_entries_public_id_key',
  'oauth_auth_codes_code_key',
  'oauth_clients_client_id_key',
  'oauth_consent_grants_code_challenge_key',
  'oauth_refresh_tokens_token_hash_key',
  'orchestration_node_executions_idempotency_key_key',
  'orchestration_run_tasks_public_id_key',
  'orchestration_runs_public_id_key',
  'orchestrations_public_id_key',
  'policies_public_id_key',
  'price_books_public_id_key',
  'projects_public_id_key',
  'quotas_public_id_key',
  'secrets_public_id_key',
  'sessions_public_id_key',
  'task_transitions_public_id_key',
  'tasks_public_id_key',
  'tools_public_id_key',
  'traces_public_id_key',
  'trigger_firings_public_id_key',
  'triggers_public_id_key',
  'upload_tokens_public_id_key',
  'usage_components_public_id_key',
  'usage_events_idempotency_key_key',
  'usage_events_public_id_key',
  'usage_thresholds_public_id_key',
  'users_public_id_key',
  'users_username_key',
  'webhook_deliveries_public_id_key',
  'webhooks_public_id_key',
  'workflows_public_id_key',
] as const;

/**
 * Generation 2 — `<table>_<field>_<field>…`, truncated by Postgres at 63 chars.
 *
 * Sequelize derives this name for an `indexes` entry that omits `name:`. #710
 * gave all nine an explicit `_unique` name; the derived names they had been
 * created under stayed in the catalog.
 *
 * A single-column unique index can appear under a generation-1 *and* a
 * generation-2 name — `usage_events.idempotency_key` was declared both ways
 * over its lifetime and held both, plus its generation-3 name, at once.
 */
const GENERATION_2_DERIVED_NAMES = [
  'actors_project_id_external_id',
  'conversation_messages_conversation_id_document_id',
  'conversation_messages_conversation_id_idempotency_key',
  'conversation_messages_conversation_id_position',
  'files_project_id_path',
  'formation_resources_formation_id_logical_id',
  'formations_project_id_name',
  'ingestion_rules_project_id_content_type_glob',
  'usage_events_idempotency_key',
] as const;

/**
 * Renamed or re-grained indexes — the residue of a deliberate schema change.
 *
 * Unlike the two generations above, these cannot be derived from the current
 * models: the field list they were built over no longer exists anywhere in the
 * tree. They are only recoverable from the history of the change that retired
 * them, which is why this list has to be written by hand.
 *
 * Both entries below are the pre-#561 `price_books` uniqueness grain. #561
 * widened it to include `component` under the name
 * `price_books_scope_sku_component_effective_uk`; the two 5-column predecessors
 * survived and kept enforcing uniqueness over
 * `(ai_provider_id, project_id, provider, model, effective_from)` — forbidding
 * exactly what #561 exists to allow. The failure stayed latent only because
 * both are `NULLS DISTINCT`: they engage once `ai_provider_id` **and**
 * `project_id` are both set, and the first fully-scoped price book with an
 * `input_tokens` and an `output_tokens` row would have hit `23505`.
 */
const RETIRED_BY_RENAME_NAMES = [
  // Generation-2 derived name of the pre-#561 5-column index (67 chars, stored
  // truncated at 63).
  'price_books_ai_provider_id_project_id_provider_model_effective_',
  // The same grain under the explicit name it carried after #508.
  'price_books_provider_model_effective_uk',
] as const;

export const RETIRED_INDEX_NAMES: readonly string[] = [
  ...GENERATION_1_COLUMN_UNIQUE_NAMES,
  ...GENERATION_2_DERIVED_NAMES,
  ...RETIRED_BY_RENAME_NAMES,
];

/**
 * A retired name that is actually present in the database, and how it is
 * materialized there. The distinction matters: a UNIQUE **constraint** owns its
 * index and can only be removed with `ALTER TABLE … DROP CONSTRAINT`, while a
 * plain index is removed with `DROP INDEX`.
 */
export type RetiredSchemaObject = {
  name: string;
  table: string;
  kind: 'constraint' | 'index';
};

const isRetiredSchemaObject = (row: unknown): row is RetiredSchemaObject => {
  if (typeof row !== 'object' || row === null) {
    return false;
  }

  const candidate: Record<string, unknown> = { ...row };

  return (
    typeof candidate.name === 'string' &&
    typeof candidate.table === 'string' &&
    (candidate.kind === 'constraint' || candidate.kind === 'index')
  );
};

/**
 * Locate retired names in the live catalog.
 *
 * The index arm excludes any index owned by a constraint (`conindid`) so a
 * UNIQUE constraint is reported once, as a constraint — dropping it via
 * `DROP INDEX` would fail with "cannot drop index … because constraint …
 * requires it".
 */
const DISCOVERY_SQL = `
  SELECT con.conname AS name, rel.relname AS table, 'constraint' AS kind
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = con.connamespace
   WHERE con.conname = ANY(ARRAY[:names]::text[])
     AND ns.nspname = current_schema()
  UNION ALL
  SELECT idx.relname AS name, tbl.relname AS table, 'index' AS kind
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
   WHERE idx.relname = ANY(ARRAY[:names]::text[])
     AND ns.nspname = current_schema()
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint c WHERE c.conindid = idx.oid
     )
`;

export const findRetiredSchemaObjects = async (args: {
  sequelize: Sequelize;
  names?: readonly string[];
  transaction?: QueryTransaction;
}): Promise<RetiredSchemaObject[]> => {
  const names = args.names ?? RETIRED_INDEX_NAMES;

  if (names.length === 0) {
    return [];
  }

  const [rows] = await args.sequelize.query(DISCOVERY_SQL, {
    replacements: { names: [...names] },
    transaction: args.transaction,
  });

  return rows.filter(isRetiredSchemaObject);
};

/**
 * Quote an identifier for interpolation into DDL.
 *
 * `DROP INDEX` and `ALTER TABLE … DROP CONSTRAINT` take an identifier, not a
 * value, so a bind parameter cannot be used. Every name reaching here was read
 * back from `pg_class` / `pg_constraint` after matching {@link
 * RETIRED_INDEX_NAMES}, but quoting is applied anyway so the DDL is correct for
 * any identifier the catalog can hold.
 */
const quoteIdentifier = (identifier: string) => {
  return `"${identifier.replace(/"/g, '""')}"`;
};

const dropStatement = (object: RetiredSchemaObject) => {
  if (object.kind === 'constraint') {
    // No CASCADE: a constraint another object depends on must fail loudly and
    // be resolved deliberately, never take its dependents down with it.
    return `ALTER TABLE ${quoteIdentifier(object.table)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(object.name)}`;
  }

  return `DROP INDEX IF EXISTS ${quoteIdentifier(object.name)}`;
};

export type DropRetiredIndexesResult = {
  dropped: string[];
  failed: { name: string; error: string }[];
};

const DEFAULT_DROP_LOCK_TIMEOUT_MS = 30_000;

/**
 * Drop every retired index and constraint present in the database.
 *
 * Idempotent by construction: it drops what the catalog actually holds, so the
 * second run — and every boot after the first — finds nothing and issues no
 * DDL.
 *
 * Runs under `advisoryLockKey` (the caller passes the same key boot-time
 * `sync` uses) so a peer still running `sync({ alter: true })` finishes first
 * and two tasks never race the same `DROP`. `pg_advisory_xact_lock` releases
 * on commit, so no unlock path can be missed.
 *
 * **Best-effort per object.** Each drop runs in its own savepoint and a failure
 * is collected in `failed` rather than thrown: an index that cannot be dropped
 * (a foreign key still depends on its constraint, `lock_timeout` expires on a
 * busy table) is a cleanup problem, and failing the boot over it would take the
 * service down for a stale object it has been running with all along. Callers
 * are expected to log `failed`.
 */
export const dropRetiredIndexes = async (args: {
  sequelize: Sequelize;
  advisoryLockKey: number;
  names?: readonly string[];
  lockTimeoutMs?: number;
}): Promise<DropRetiredIndexesResult> => {
  const lockTimeoutMs = args.lockTimeoutMs ?? DEFAULT_DROP_LOCK_TIMEOUT_MS;
  const result: DropRetiredIndexesResult = { dropped: [], failed: [] };

  await args.sequelize.transaction(async (transaction) => {
    // Bounds both the advisory-lock wait and each DROP's wait for ACCESS
    // EXCLUSIVE, so a long-running query on a hot table cannot stall boot.
    await args.sequelize.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`, {
      transaction,
    });
    await args.sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
      replacements: { key: args.advisoryLockKey },
      transaction,
    });

    const objects = await findRetiredSchemaObjects({
      sequelize: args.sequelize,
      names: args.names,
      transaction,
    });

    for (const object of objects) {
      try {
        // A nested transaction is a SAVEPOINT: one failed DROP rolls back to
        // here instead of aborting the whole cleanup.
        await args.sequelize.transaction({ transaction }, async (savepoint) => {
          await args.sequelize.query(dropStatement(object), {
            transaction: savepoint,
          });
        });
        result.dropped.push(object.name);
      } catch (error) {
        result.failed.push({
          name: object.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  return result;
};
