import { defineMigration } from '@ttoss/postgresdb';

/**
 * Foreign-key columns the models declare nullable that a database built from
 * an earlier model still holds `NOT NULL`.
 *
 * `sync({ alter: true })` rewrites a column that carries `references` as its
 * foreign key alone and never emits `DROP NOT NULL`, so a nullability change
 * on such a column reaches a database only through a migration.
 * `tests/unit/tests/foreignKeyNullability.test.ts` pins the set that holds.
 */
const RELAXED = [
  { table: 'agents', column: 'ai_provider_id' },
  { table: 'chats', column: 'ai_provider_id' },
  { table: 'api_keys', column: 'project_id' },
  { table: 'conversation_messages', column: 'actor_id' },
];

const NOT_NULL_SQL = `
  SELECT table_name, column_name FROM information_schema.columns
   WHERE table_schema = current_schema() AND is_nullable = 'NO'
`;

export const foreignKeyNullability = defineMigration({
  name: '2026-09-24-foreign-key-nullability',
  description:
    'agents.ai_provider_id, chats.ai_provider_id, api_keys.project_id and conversation_messages.actor_id nullable, as their models declare.',
  /**
   * A table or column the database has not got is one `sync` builds from the
   * models, nullable already, so only a column held `NOT NULL` is pending.
   */
  isApplied: async (context) => {
    const held = await context.select<{
      table_name: string;
      column_name: string;
    }>({ sql: NOT_NULL_SQL });
    return !RELAXED.some((relaxed) => {
      return held.some((row) => {
        return (
          row.table_name === relaxed.table && row.column_name === relaxed.column
        );
      });
    });
  },
  up: async (context) => {
    for (const relaxed of RELAXED) {
      if (
        !(await context.columnExists({
          table: relaxed.table,
          column: relaxed.column,
        }))
      ) {
        continue;
      }
      context.say(`making ${relaxed.table}.${relaxed.column} nullable`);
      await context.run({
        sql: `ALTER TABLE ${relaxed.table} ALTER COLUMN ${relaxed.column} DROP NOT NULL`,
      });
    }
  },
});
