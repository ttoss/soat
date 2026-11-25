import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

// Rebuilt over `json_each ... WITH ORDINALITY` so every key keeps its
// position; `name` goes after the scorer's other keys.
const FUNCTIONS_SQL = `
  CREATE OR REPLACE FUNCTION pg_temp.soat_named_scorer(s json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN json_typeof(s) = 'object' AND s->'name' IS NULL
       AND json_typeof(s->'type') = 'string' THEN (
        SELECT json_object_agg(k.key, k.value ORDER BY k.ord)
          FROM (
            SELECT e.key, e.value, e.ord
              FROM json_each(s) WITH ORDINALITY AS e(key, value, ord)
            UNION ALL
            SELECT 'name', s->'type', 9223372036854775807
          ) AS k)
      ELSE s END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_named_scorers(a json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(a) = 'array' THEN (
      SELECT COALESCE(
        json_agg(pg_temp.soat_named_scorer(x.value) ORDER BY x.ord), '[]'::json)
        FROM json_array_elements(a) WITH ORDINALITY AS x(value, ord))
    ELSE a END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_named_definition(d json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(d) = 'object' THEN (
      SELECT COALESCE(json_object_agg(e.key,
        CASE WHEN e.key = 'scorers' THEN pg_temp.soat_named_scorers(e.value)
        ELSE e.value END
        ORDER BY e.ord), '{}'::json)
        FROM json_each(d) WITH ORDINALITY AS e(key, value, ord))
    ELSE d END
  $$;
`;

const HAS_UNNAMED = (scorers: string): string => {
  return `EXISTS (
    SELECT 1 FROM json_array_elements(
      CASE WHEN json_typeof(${scorers}) = 'array' THEN ${scorers} ELSE '[]'::json END
    ) AS s
     WHERE json_typeof(s) = 'object' AND s->'name' IS NULL
       AND json_typeof(s->'type') = 'string')`;
};

const TABLES = [
  {
    table: 'evals',
    pending: HAS_UNNAMED('scorers'),
    update: 'UPDATE evals SET scorers = pg_temp.soat_named_scorers(scorers)',
  },
  {
    table: 'eval_runs',
    pending: HAS_UNNAMED(`definition->'scorers'`),
    update: `UPDATE eval_runs
       SET definition = pg_temp.soat_named_definition(definition)`,
  },
] as const;

type Table = (typeof TABLES)[number];

const pendingTables = async (context: MigrationContext): Promise<Table[]> => {
  const pending: Table[] = [];
  for (const entry of TABLES) {
    if (!(await context.tableExists({ table: entry.table }))) continue;
    const rows = await context.select<{ one: number }>({
      sql: `SELECT 1 AS one FROM ${entry.table} WHERE ${entry.pending} LIMIT 1`,
    });
    if (rows.length > 0) pending.push(entry);
  }
  return pending;
};

/**
 * Every scorer has a `name`: one stored without it, in an Eval or a run's
 * definition, takes its `type`, the key its outcomes are already stored under.
 */
export const scorerNamesRequired = defineMigration({
  name: '2026-11-25-scorer-names-required',
  description:
    'evals.scorers and eval_runs.definition.scorers: a scorer without a name takes its type.',
  isApplied: async (context) => {
    return (await pendingTables(context)).length === 0;
  },
  up: async (context) => {
    const pending = await pendingTables(context);
    if (pending.length === 0) return;
    context.say(
      `naming scorers in ${pending
        .map((entry) => {
          return entry.table;
        })
        .join(', ')}`
    );
    await context.run({
      sql: [
        FUNCTIONS_SQL,
        ...pending.map((entry) => {
          return `${entry.update} WHERE ${entry.pending};`;
        }),
      ].join('\n'),
    });
  },
});
