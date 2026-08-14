/**
 * One-time normalization of rows written before a shape was single-cased.
 *
 * These exist because this project has no migration framework: the schema is
 * whatever boot-time `sync({ alter: true })` makes it (`db.ts`). That is enough
 * for DDL, but it moves no data — and one of these backfills has to run *before*
 * the DDL, because `sync({ alter: true })` **drops** a column the model stopped
 * declaring, taking its contents with it. So the backfills run from a
 * `beforeBulkSync` hook: inside `sequelize.sync()`, which is inside
 * `syncWithAdvisoryLock`'s critical section, so a concurrently-booting peer
 * cannot drop the columns in between (see `syncSchemaWithAdvisoryLock`).
 *
 * Every runner is **idempotent** and selects only the rows still holding the old
 * shape, so a second boot is a cheap no-op and the whole module becomes dead
 * weight once every deployment has booted once. Reads and writes go through raw
 * parameterized SQL rather than the models on purpose: the schema has not been
 * altered yet when they run, so a model-shaped query could name a column the
 * table does not have. The normalizers themselves are pure, so the fiddly part
 * is tested without a database.
 *
 * A malformed value is left alone rather than thrown on. These run on the boot
 * path, where a raised error is a server that will not start — a single
 * hand-edited row must not be able to do that.
 */
import type { Sequelize } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { isPlainObject } from './plainObject';

const log = createDebug('soat:backfill');

/** A normalization result: the new value, and whether it differs from the old. */
type Normalized = { changed: boolean; value: unknown };

const unchanged = (value: unknown): Normalized => {
  return { changed: false, value };
};

/**
 * Moves one camelCase key onto its wire spelling. The wire spelling wins when a
 * row carries both — it is the one every reader has preferred all along, so
 * keeping it is what makes this backfill invisible rather than a behavior change.
 */
const renameKey = (args: {
  record: Record<string, unknown>;
  from: string;
  to: string;
}): boolean => {
  const { record, from, to } = args;
  if (!(from in record)) return false;
  if (!(to in record)) record[to] = record[from];
  delete record[from];
  return true;
};

// ── Pure normalizers ──────────────────────────────────────────────────────

/**
 * `{ type: 'tool', toolName }` → `{ type: 'tool', tool_name }`.
 *
 * The string forms (`auto` / `required` / `none`) carry no key and pass through.
 */
export const normalizeStoredToolChoice = (value: unknown): Normalized => {
  if (!isPlainObject(value)) return unchanged(value);
  if (value.type !== 'tool') return unchanged(value);

  const next = { ...value };
  const changed = renameKey({
    record: next,
    from: 'toolName',
    to: 'tool_name',
  });
  return changed ? { changed, value: next } : unchanged(value);
};

/**
 * A `step_rules` array's `toolChoice` / `activeToolIds` keys, plus the nested
 * tool name inside each rule's choice. Rule order is preserved — `step_rules`
 * is matched by its `step` field, but an array that came back reordered would
 * still be a gratuitous diff on the row.
 */
export const normalizeStoredStepRules = (value: unknown): Normalized => {
  if (!Array.isArray(value)) return unchanged(value);

  let changed = false;
  const rules = value.map((rule) => {
    if (!isPlainObject(rule)) return rule;

    const next = { ...rule };
    if (renameKey({ record: next, from: 'toolChoice', to: 'tool_choice' })) {
      changed = true;
    }
    if (
      renameKey({ record: next, from: 'activeToolIds', to: 'active_tool_ids' })
    ) {
      changed = true;
    }

    const choice = normalizeStoredToolChoice(next.tool_choice);
    if (choice.changed) {
      next.tool_choice = choice.value;
      changed = true;
    }
    return changed ? next : rule;
  });

  return changed ? { changed, value: rules } : unchanged(value);
};

/**
 * A tool's `execute`, in the two pre-single-casing shapes: persisted as a JSON
 * **string** rather than an object, and carrying `bodyMode` rather than
 * `body_mode`.
 *
 * A string that does not parse — or parses to something other than an object —
 * is left exactly as it was. `parseHttpExecuteConfig` rejects such a value with
 * a clear "invalid execute" tool error already; rewriting it here would only
 * turn a legible failure into a different one.
 */
export const normalizeStoredExecute = (value: unknown): Normalized => {
  let parsed: unknown = value;
  let changed = false;

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return unchanged(value);
    }
    if (!isPlainObject(parsed)) return unchanged(value);
    changed = true;
  }

  if (!isPlainObject(parsed)) return unchanged(value);

  const next = { ...parsed };
  if (renameKey({ record: next, from: 'bodyMode', to: 'body_mode' })) {
    changed = true;
  }
  return changed ? { changed, value: next } : unchanged(value);
};

/**
 * The inline `tool.execute` of every entry in an agent's `tool_bindings`. A
 * reference entry (`{ toolId }`) has no inline definition and is passed through.
 */
export const normalizeStoredToolBindings = (value: unknown): Normalized => {
  if (!Array.isArray(value)) return unchanged(value);

  let changed = false;
  const bindings = value.map((binding) => {
    if (!isPlainObject(binding) || !isPlainObject(binding.tool)) return binding;
    const execute = normalizeStoredExecute(binding.tool.execute);
    if (!execute.changed) return binding;
    changed = true;
    return { ...binding, tool: { ...binding.tool, execute: execute.value } };
  });

  return changed ? { changed, value: bindings } : unchanged(value);
};

// ── Runners ───────────────────────────────────────────────────────────────

const columnExists = async (args: {
  sequelize: Sequelize;
  table: string;
  column: string;
}): Promise<boolean> => {
  const [rows] = await args.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = :table
        AND column_name = :column`,
    { replacements: { table: args.table, column: args.column } }
  );
  return rows.length > 0;
};

/**
 * Derives `tool_bindings` for agent rows that only ever held the
 * pre-`toolBindings` `tool_ids` / `tools` columns, so the boot-time
 * `sync({ alter: true })` that drops those columns cannot take an agent's tool
 * attachments with it.
 *
 * The derivation is `readAgentToolBindings`': reference entries first, inline
 * entries after — the only stable order the two-array storage ever implied. A
 * row whose legacy pair is empty is left `NULL` rather than written as `[]`,
 * matching what `readAgentToolBindings` returned and what `mapAgent` renders as
 * `tool_bindings: null`.
 *
 * Returns 0 once the columns are gone, which is every boot after the first.
 */
export const backfillAgentToolBindings = async (args: {
  sequelize: Sequelize;
}): Promise<number> => {
  const present = await Promise.all(
    ['tool_ids', 'tools'].map((column) => {
      return columnExists({
        sequelize: args.sequelize,
        table: 'agents',
        column,
      });
    })
  );
  if (!present.some(Boolean)) {
    log('backfillAgentToolBindings: legacy columns absent, nothing to do');
    return 0;
  }

  const [hasToolIds, hasTools] = present;
  // A column that no longer exists cannot be read at all, so each half of the
  // derivation is compiled in only when its column is there. `jsonb_typeof`
  // guards the rest: a hand-edited non-array would make
  // `jsonb_array_elements` raise, and this runs on the boot path.
  const refs = hasToolIds
    ? `CASE WHEN jsonb_typeof(tool_ids) = 'array' THEN COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('toolId', entry))
            FROM jsonb_array_elements_text(tool_ids) AS entry),
         '[]'::jsonb) ELSE '[]'::jsonb END`
    : `'[]'::jsonb`;
  const inline = hasTools
    ? `CASE WHEN jsonb_typeof(tools) = 'array' THEN COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('tool', entry))
            FROM jsonb_array_elements(tools) AS entry),
         '[]'::jsonb) ELSE '[]'::jsonb END`
    : `'[]'::jsonb`;
  // Only rows that will actually produce a binding. A row whose legacy pair is
  // empty (or a non-array) derives nothing, and matching it would rewrite NULL
  // over NULL on every boot forever — the WHERE would stay true, since it is
  // `tool_bindings IS NULL` that makes a row eligible in the first place.
  const eligible = [
    hasToolIds
      ? `(jsonb_typeof(tool_ids) = 'array' AND jsonb_array_length(tool_ids) > 0)`
      : null,
    hasTools
      ? `(jsonb_typeof(tools) = 'array' AND jsonb_array_length(tools) > 0)`
      : null,
  ]
    .filter(Boolean)
    .join(' OR ');

  // `RETURNING` rather than the driver's affected-row metadata: the count is
  // then a row set this code owns, not a dialect-shaped field.
  const [rows] = await args.sequelize.query(
    `UPDATE agents
        SET tool_bindings = ${refs} || ${inline}
      WHERE tool_bindings IS NULL
        AND (${eligible})
      RETURNING id`
  );
  log('backfillAgentToolBindings: updated=%d', rows.length);
  return rows.length;
};

/**
 * Rewrites one JSON column, row by row, through a pure normalizer. The rows are
 * fetched with a `WHERE` narrow enough that a settled deployment reads nothing,
 * and each write is a single parameterized `UPDATE` by primary key.
 */
const normalizeJsonColumns = async (args: {
  sequelize: Sequelize;
  table: string;
  columns: Array<{ column: string; normalize: (value: unknown) => Normalized }>;
  candidateWhere: string;
}): Promise<number> => {
  const selected = args.columns
    .map((entry) => {
      return entry.column;
    })
    .join(', ');
  const [rows] = await args.sequelize.query(
    `SELECT id, ${selected} FROM ${args.table} WHERE ${args.candidateWhere}`
  );

  let updated = 0;
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const assignments: string[] = [];
    const replacements: Record<string, unknown> = { id: row.id };

    for (const { column, normalize } of args.columns) {
      const result = normalize(row[column]);
      if (!result.changed) continue;
      assignments.push(`${column} = :${column}`);
      replacements[column] =
        result.value === null ? null : JSON.stringify(result.value);
    }

    if (assignments.length === 0) continue;
    await args.sequelize.query(
      `UPDATE ${args.table} SET ${assignments.join(', ')} WHERE id = :id`,
      { replacements }
    );
    updated += 1;
  }

  log('normalizeJsonColumns: table=%s updated=%d', args.table, updated);
  return updated;
};

/**
 * Agent `tool_choice` and `step_rules` written while the request middleware
 * camelCased nested keys, so a stored rule reads `toolChoice` / `activeToolIds`
 * / `toolName` instead of the wire spellings.
 *
 * Without this, removing the readers' camelCase fallback would make such a rule
 * silently stop forcing its tool — the worst shape of regression, since the
 * agent keeps answering and only the guarantee is gone.
 */
export const backfillAgentStepRules = async (args: {
  sequelize: Sequelize;
}): Promise<number> => {
  return normalizeJsonColumns({
    sequelize: args.sequelize,
    table: 'agents',
    columns: [
      { column: 'tool_choice', normalize: normalizeStoredToolChoice },
      { column: 'step_rules', normalize: normalizeStoredStepRules },
    ],
    // `::text LIKE` rather than a key test: `toolName` can sit nested inside a
    // rule's choice, at a depth no single `?` operator reaches.
    candidateWhere: `tool_choice::text LIKE '%toolName%'
                     OR step_rules::text LIKE '%toolChoice%'
                     OR step_rules::text LIKE '%activeToolIds%'
                     OR step_rules::text LIKE '%toolName%'`,
  });
};

/**
 * Tool `execute` payloads persisted as a JSON string, or carrying `bodyMode`
 * instead of `body_mode` — on the `tools` table and on the inline definitions
 * inside an agent's `tool_bindings`, which is the other place an `execute` lives.
 */
export const backfillToolExecute = async (args: {
  sequelize: Sequelize;
}): Promise<number> => {
  const tools = await normalizeJsonColumns({
    sequelize: args.sequelize,
    table: 'tools',
    columns: [{ column: 'execute', normalize: normalizeStoredExecute }],
    candidateWhere: `jsonb_typeof(execute) = 'string'
                     OR execute::text LIKE '%bodyMode%'`,
  });
  const agents = await normalizeJsonColumns({
    sequelize: args.sequelize,
    table: 'agents',
    columns: [
      { column: 'tool_bindings', normalize: normalizeStoredToolBindings },
    ],
    candidateWhere: `tool_bindings::text LIKE '%bodyMode%'
                     OR tool_bindings::text LIKE '%"execute": "%'`,
  });
  return tools + agents;
};

/**
 * Every backfill, in the one order that matters: `backfillAgentToolBindings`
 * reads columns this boot's `sync` is about to drop, so it goes first.
 *
 * A failure here fails the boot deliberately. These run before the DDL, and a
 * boot that skipped the backfill and synced anyway would drop the legacy columns
 * with rows still unmigrated — silent, permanent data loss. Refusing to start is
 * the recoverable outcome.
 */
export const runDataBackfills = async (args: {
  sequelize: Sequelize;
}): Promise<void> => {
  log('runDataBackfills: start');
  await backfillAgentToolBindings(args);
  await backfillAgentStepRules(args);
  await backfillToolExecute(args);
  log('runDataBackfills: done');
};
