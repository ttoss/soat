import { defineMigration } from '@ttoss/postgresdb';

/**
 * `api_keys.key_hash_sha256` is the column a bearer is verified by, and
 * `api_keys.key_hash` (bcrypt) becomes nullable because a key minted with a
 * SHA-256 carries no bcrypt hash.
 *
 * `sync` never alters an existing table, so both are a migration. The unique
 * index over `key_hash_sha256` is declared by the model and built by the schema
 * sync `prepareSchema` runs after every migration.
 */
export const apiKeySha256 = defineMigration({
  name: '2026-09-24-api-key-sha256',
  description:
    'api_keys.key_hash_sha256, the SHA-256 a key is verified by, and api_keys.key_hash nullable, since a SHA-256 key carries no bcrypt hash.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'api_keys' }))) {
      return true;
    }
    if (
      !(await context.columnExists({
        table: 'api_keys',
        column: 'key_hash_sha256',
      }))
    ) {
      return false;
    }
    const [column] = await context.select<{ is_nullable: string }>({
      sql: `SELECT is_nullable FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'api_keys' AND column_name = 'key_hash'`,
    });
    return column?.is_nullable !== 'NO';
  },
  up: async (context) => {
    context.say('adding api_keys.key_hash_sha256');
    await context.addColumnIfMissing({
      table: 'api_keys',
      column: 'key_hash_sha256',
      type: 'varchar(64)',
    });
    context.say('making api_keys.key_hash nullable');
    await context.run({
      sql: 'ALTER TABLE api_keys ALTER COLUMN key_hash DROP NOT NULL',
    });
  },
});
