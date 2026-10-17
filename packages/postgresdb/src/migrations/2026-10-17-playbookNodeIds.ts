import { defineMigration } from '@ttoss/postgresdb';

// Each helper rebuilds an object over `json_each ... WITH ORDINALITY`, so every
// key keeps its position.
const FUNCTIONS_SQL = `
  CREATE OR REPLACE FUNCTION pg_temp.soat_input(i json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(i) = 'object' THEN (
      SELECT COALESCE(json_object_agg(e.key,
        CASE WHEN e.key = 'source' AND json_typeof(e.value) = 'object' THEN (
          SELECT json_object_agg(
            CASE WHEN s.key = 'node' THEN 'node_id' ELSE s.key END, s.value
            ORDER BY s.ord)
            FROM json_each(e.value) WITH ORDINALITY AS s(key, value, ord))
        ELSE e.value END
        ORDER BY e.ord), '{}'::json)
        FROM json_each(i) WITH ORDINALITY AS e(key, value, ord))
    ELSE i END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_node(n json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(n) = 'object' THEN (
      SELECT COALESCE(json_object_agg(
        CASE WHEN e.key = 'key' THEN 'id' ELSE e.key END,
        CASE WHEN e.key = 'inputs' AND json_typeof(e.value) = 'array' THEN (
          SELECT COALESCE(
            json_agg(pg_temp.soat_input(x.value) ORDER BY x.ord), '[]'::json)
            FROM json_array_elements(e.value) WITH ORDINALITY AS x(value, ord))
        ELSE e.value END
        ORDER BY e.ord), '{}'::json)
        FROM json_each(n) WITH ORDINALITY AS e(key, value, ord))
    ELSE n END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_definition(d json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(d) = 'object' THEN (
      SELECT COALESCE(json_object_agg(e.key,
        CASE WHEN e.key = 'nodes' AND json_typeof(e.value) = 'array' THEN (
          SELECT COALESCE(
            json_agg(pg_temp.soat_node(x.value) ORDER BY x.ord), '[]'::json)
            FROM json_array_elements(e.value) WITH ORDINALITY AS x(value, ord))
        ELSE e.value END
        ORDER BY e.ord), '{}'::json)
        FROM json_each(d) WITH ORDINALITY AS e(key, value, ord))
    ELSE d END
  $$;

  CREATE OR REPLACE FUNCTION pg_temp.soat_config(c json) RETURNS json
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN json_typeof(c) = 'object' THEN (
      SELECT COALESCE(json_object_agg(e.key,
        CASE WHEN e.key = 'definition' THEN pg_temp.soat_definition(e.value)
        ELSE e.value END
        ORDER BY e.ord), '{}'::json)
        FROM json_each(c) WITH ORDINALITY AS e(key, value, ord))
    ELSE c END
  $$;
`;

// A stored node always carries `key` until this runs, so its presence is what
// marks a definition as not yet renamed.
const HAS_KEYED_NODE = (nodes: string): string => {
  return `EXISTS (
    SELECT 1 FROM json_array_elements(
      CASE WHEN json_typeof(${nodes}) = 'array' THEN ${nodes} ELSE '[]'::json END
    ) AS n
     WHERE json_typeof(n) = 'object' AND n->'key' IS NOT NULL)`;
};

const HAS_NODE_CHANGE = `jsonb_typeof(diff->'changed') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(diff->'changed') AS c WHERE c ? 'node')`;

const TABLES = [
  {
    table: 'playbooks',
    pending: HAS_KEYED_NODE(`definition->'nodes'`),
    update: `UPDATE playbooks
       SET definition = pg_temp.soat_definition(definition)`,
  },
  {
    table: 'playbook_versions',
    pending: HAS_KEYED_NODE(`config->'definition'->'nodes'`),
    update: `UPDATE playbook_versions
       SET config = pg_temp.soat_config(config)`,
  },
  {
    table: 'playbook_upgrades',
    pending: HAS_NODE_CHANGE,
    update: `UPDATE playbook_upgrades
       SET diff = jsonb_set(diff, '{changed}', (
         SELECT COALESCE(jsonb_agg(
           CASE WHEN c.value ? 'node' THEN (c.value - 'node')
             || jsonb_build_object('node_id', c.value->'node')
           ELSE c.value END
           ORDER BY c.ord), '[]'::jsonb)
           FROM jsonb_array_elements(diff->'changed')
             WITH ORDINALITY AS c(value, ord)))`,
  },
];

/**
 * A playbook node is named by `id` and an input's source reads `node_id`, the
 * names an orchestration uses for the same two things.
 *
 * - Every stored definition — `playbooks.definition` and each
 *   `playbook_versions.config.definition` — has each node's `key` renamed `id`
 *   and each input source's `node` renamed `node_id`, in place, so a node keeps
 *   its field order (both columns are `json` for that order).
 * - Every `playbook_upgrades.diff.changed[]` entry has `node` renamed
 *   `node_id`.
 *
 * One statement string, so no definition is left half renamed. A table that
 * does not exist yet is left to `sync`.
 */
export const playbookNodeIds = defineMigration({
  name: '2026-10-17-playbook-node-ids',
  description:
    'Playbook node key renamed id and input source node renamed node_id in stored definitions and upgrade diffs.',
  isApplied: async (context) => {
    for (const { table, pending } of TABLES) {
      if (!(await context.tableExists({ table }))) continue;
      const rows = await context.select({
        sql: `SELECT 1 FROM ${table} WHERE ${pending} LIMIT 1`,
      });
      if (rows.length > 0) return false;
    }
    return true;
  },
  up: async (context) => {
    const updates: string[] = [];
    for (const { table, pending, update } of TABLES) {
      if (await context.tableExists({ table })) {
        updates.push(`${update} WHERE ${pending};`);
      }
    }
    context.say('renaming playbook node keys to ids in stored definitions');
    await context.run({ sql: [FUNCTIONS_SQL, ...updates].join('\n') });
  },
});
