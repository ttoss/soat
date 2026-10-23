import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import {
  hashNormalizedMemoryContent,
  MIGRATIONS,
} from '../../../dist/index.cjs';
import {
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_memory_content_hash_${process.pid}`;
const NAME = '2026-10-23-memory-content-normalized-hash';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const CONTENTS = [
  'Customer prefers email.',
  'customer prefers EMAIL',
  'Fiscal year ends in December',
];

beforeAll(async () => {
  await startDatabaseServer();
});

afterAll(async () => {
  await dropDatabase(DATABASE);
  await stopDatabaseServer();
});

describe(NAME, () => {
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE memory_contents (
        id serial PRIMARY KEY,
        memory_store_id integer NOT NULL,
        content text NOT NULL,
        content_hash varchar(64) NOT NULL
      );
      INSERT INTO memory_contents (memory_store_id, content, content_hash)
      VALUES ${CONTENTS.map((content, index) => {
        return `(1, '${content}', 'hash_${index}')`;
      }).join(', ')};
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('every row keeps its own text and gets the normalized hash', async () => {
    const rows = await selectRows<{ content: string; normalized_hash: string }>(
      {
        client,
        sql: 'SELECT content, normalized_hash FROM memory_contents ORDER BY id',
      }
    );

    expect(rows).toEqual(
      CONTENTS.map((content) => {
        return {
          content,
          normalized_hash: hashNormalizedMemoryContent({ content }),
        };
      })
    );
    expect(rows[0].normalized_hash).toBe(rows[1].normalized_hash);
  });

  test('the column is not null and indexed', async () => {
    const [column] = await selectRows<{ is_nullable: string }>({
      client,
      sql: `SELECT is_nullable FROM information_schema.columns
             WHERE table_name = 'memory_contents'
               AND column_name = 'normalized_hash'`,
    });
    const indexes = await selectRows<{ indexname: string }>({
      client,
      sql: `SELECT indexname FROM pg_indexes
             WHERE indexname = 'memory_contents_store_normalized_hash_idx'`,
    });

    expect(column.is_nullable).toBe('NO');
    expect(indexes).toHaveLength(1);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
