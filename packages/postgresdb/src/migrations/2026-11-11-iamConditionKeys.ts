import { defineMigration, type MigrationContext } from '@ttoss/postgresdb';

/**
 * Policy condition keys and variables live in the `iam:` namespace. Every
 * stored document is rewritten: `policies.document`, and the templates and
 * last-applied properties a formation keeps for a `policy` resource, which a
 * later deploy re-validates.
 */
const RENAMES: Array<[string, string]> = [
  ['"soat:ResourceType"', '"iam:ResourceType"'],
  ['"soat:ResourceTag/', '"iam:ResourceTag/'],
  ['${soat:ActorId}', '${iam:ActorId}'],
];

const holdsOldKey = (column: string) => {
  return RENAMES.map(([from]) => {
    return `strpos(${column}::text, '${from}') > 0`;
  }).join(' OR ');
};

const renamed = (column: string) => {
  return RENAMES.reduce((sql, [from, to]) => {
    return `replace(${sql}, '${from}', '${to}')`;
  }, `${column}::text`);
};

const COLUMNS = [
  { table: 'policies', column: 'document' },
  { table: 'formations', column: 'template' },
  { table: 'formation_resources', column: 'last_applied_properties' },
];

const presentColumns = async (context: MigrationContext) => {
  const present: typeof COLUMNS = [];
  for (const entry of COLUMNS) {
    if (
      (await context.tableExists({ table: entry.table })) &&
      (await context.columnExists(entry))
    ) {
      present.push(entry);
    }
  }
  return present;
};

export const iamConditionKeys = defineMigration({
  name: '2026-11-11-iam-condition-keys',
  description:
    'Policy condition keys and variables in the iam: namespace, wherever a policy document is stored: policies and stored formation templates.',
  isApplied: async (context) => {
    for (const { table, column } of await presentColumns(context)) {
      const rows = await context.select({
        sql: `SELECT 1 FROM ${table} WHERE ${holdsOldKey(column)} LIMIT 1`,
      });
      if (rows.length > 0) return false;
    }
    return true;
  },
  up: async (context) => {
    context.say('renaming stored policy condition keys');
    const statements = (await presentColumns(context)).map(
      ({ table, column }) => {
        return `UPDATE ${table} SET ${column} = ${renamed(column)}::jsonb
           WHERE ${holdsOldKey(column)};`;
      }
    );
    if (statements.length === 0) return;
    // One statement string, so no document is left half renamed.
    await context.run({ sql: statements.join('\n') });
  },
});
