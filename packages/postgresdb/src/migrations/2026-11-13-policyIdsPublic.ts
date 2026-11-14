import type { MigrationContext } from '@ttoss/postgresdb';
import { defineMigration } from '@ttoss/postgresdb';

const TABLES = ['api_keys', 'users'] as const;

const tableList = TABLES.map((table) => {
  return `'${table}'`;
}).join(', ');

/** The tables whose `policy_ids` still holds internal integer ids. */
const integerTables = async (context: MigrationContext): Promise<string[]> => {
  const rows = await context.select<{ table_name: string }>({
    sql: `SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN (${tableList})
             AND column_name = 'policy_ids'
             AND udt_name = '_int4'
           ORDER BY table_name`,
  });
  return rows.map((row) => {
    return row.table_name;
  });
};

/**
 * Each id becomes the policy's public id, in the order stored. An id naming no
 * policy granted nothing, so a user drops it; on a key it capped, so it stays
 * as an id no policy holds, which allows nothing rather than lifting the cap.
 */
const convert = (table: string) => {
  const unresolved =
    table === 'api_keys' ? `'pol_unresolved_' || ids.id` : 'NULL';
  return `
    ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS policy_public_ids varchar(255)[];

    UPDATE ${table} SET policy_public_ids = (
      SELECT COALESCE(
        array_agg(COALESCE(p.public_id, ${unresolved}) ORDER BY ids.ord)
          FILTER (WHERE COALESCE(p.public_id, ${unresolved}) IS NOT NULL),
        '{}')
      FROM unnest(${table}.policy_ids) WITH ORDINALITY AS ids(id, ord)
      LEFT JOIN policies p ON p.id = ids.id
    );

    ALTER TABLE ${table} DROP COLUMN policy_ids;
    ALTER TABLE ${table} RENAME COLUMN policy_public_ids TO policy_ids;
    ALTER TABLE ${table} ALTER COLUMN policy_ids SET DEFAULT '{}';
    ALTER TABLE ${table} ALTER COLUMN policy_ids SET NOT NULL;
  `;
};

/**
 * `api_keys.policy_ids` and `users.policy_ids` store policy public ids, the
 * one form every other `policy_ids` carrier stores.
 */
export const policyIdsPublic = defineMigration({
  name: '2026-11-13-policy-ids-public',
  description:
    'api_keys.policy_ids and users.policy_ids from internal integer ids to policy public ids.',
  isApplied: async (context) => {
    return (await integerTables(context)).length === 0;
  },
  up: async (context) => {
    const tables = await integerTables(context);
    context.say(`converting policy_ids on ${tables.join(', ')}`);
    if (tables.length === 0) return;
    await context.run({ sql: tables.map(convert).join('\n') });
  },
});
