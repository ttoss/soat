import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  createDatabase,
  dropDatabase,
  selectRows,
  tableExists,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_lexical_gin_indexes_${process.pid}`;
const NAME = '2026-11-26-lexical-gin-indexes';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    // One of the two searched tables, so the run is observed both indexing a
    // table it finds and leaving alone one this database has not got.
    await client.query(`
      CREATE TABLE document_chunks (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        content text NOT NULL
      );

      INSERT INTO document_chunks (public_id, content) VALUES
        ('chk_refund', 'The refund policy allows returns'),
        ('chk_shipping', 'Shipping takes three days');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('the index is the one the model declares', async () => {
    const [row] = await selectRows<{ definition: string }>({
      client,
      sql: `SELECT indexdef AS definition FROM pg_indexes
             WHERE indexname = 'document_chunks_content_lexical_gin_idx'`,
    });

    expect(row.definition).toContain('USING gin');
    expect(row.definition).toContain(
      "to_tsvector('simple'::regconfig, content)"
    );
    expect(row.definition).toContain('octet_length(content) <= 524288');
  });

  test('a lexical match still answers the same rows', async () => {
    const rows = await selectRows<{ public_id: string }>({
      client,
      sql: `SELECT public_id FROM document_chunks
             WHERE to_tsvector('simple', content) @@ websearch_to_tsquery('simple', 'refund')
               AND octet_length(content) <= 524288`,
    });

    expect(
      rows.map((row) => {
        return row.public_id;
      })
    ).toEqual(['chk_refund']);
  });

  test('a searched table the database has not got is skipped, not failed', async () => {
    expect(await tableExists({ client, table: 'memory_contents' })).toBe(false);

    const report = await runnerFor({ client }).status();
    const entry = report.migrations.find((migration) => {
      return migration.name === NAME;
    });

    expect(entry?.applied).not.toBeNull();
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });

    expect(result.applied).toEqual([]);
  });
});
