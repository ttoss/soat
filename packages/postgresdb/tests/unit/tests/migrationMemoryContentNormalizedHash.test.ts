import { createHash } from 'node:crypto';

import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { hashMemoryContent, MIGRATIONS } from '../../../dist/index.cjs';
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

const legacyHash = (content: string) => {
  return createHash('sha256')
    .update(content.trim().replace(/\s+/g, ' '))
    .digest('hex');
};

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

    const row = (args: {
      id: number;
      store: number;
      content: string;
      embedding: string;
      age: number;
    }) => {
      return `(${args.id}, ${args.store}, '${args.content}',
        '${legacyHash(args.content)}', ${args.embedding},
        now() - interval '${args.age} hours')`;
    };

    // Rows 1 and 2 collide once case and punctuation are ignored; the oldest
    // has no vector, so which one survives and which vector it keeps are both
    // visible. Row 4 is the same text in another store.
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE memory_contents (
        id serial PRIMARY KEY,
        memory_store_id integer NOT NULL,
        content text NOT NULL,
        content_hash varchar(64) NOT NULL,
        embedding vector(3),
        created_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX memory_contents_store_hash_unique
        ON memory_contents (memory_store_id, content_hash);
      CREATE TABLE memories (
        id serial PRIMARY KEY,
        content_id integer NOT NULL
          REFERENCES memory_contents (id) ON DELETE CASCADE
      );
      CREATE TABLE memory_assertions (
        id serial PRIMARY KEY,
        content_id integer NOT NULL
          REFERENCES memory_contents (id) ON DELETE CASCADE
      );

      INSERT INTO memory_contents
        (id, memory_store_id, content, content_hash, embedding, created_at)
      VALUES
        ${row({ id: 1, store: 1, content: 'Customer prefers email.', embedding: 'NULL', age: 3 })},
        ${row({ id: 2, store: 1, content: 'customer prefers EMAIL', embedding: `'[1,2,3]'`, age: 2 })},
        ${row({ id: 3, store: 1, content: 'Fiscal year ends in December', embedding: 'NULL', age: 1 })},
        ${row({ id: 4, store: 2, content: 'customer prefers email', embedding: 'NULL', age: 1 })};

      INSERT INTO memories (content_id) VALUES (1), (2), (3), (4);
      INSERT INTO memory_assertions (content_id) VALUES (1), (2);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('rows equal once normalized collapse onto the oldest, keeping its text', async () => {
    const rows = await selectRows<{ id: number; content: string }>({
      client,
      sql: 'SELECT id, content FROM memory_contents ORDER BY id',
    });

    expect(rows).toEqual([
      { id: 1, content: 'Customer prefers email.' },
      { id: 3, content: 'Fiscal year ends in December' },
      { id: 4, content: 'customer prefers email' },
    ]);
  });

  test('every hash is the shared normalized hash', async () => {
    const rows = await selectRows<{ content: string; content_hash: string }>({
      client,
      sql: 'SELECT content, content_hash FROM memory_contents',
    });

    for (const row of rows) {
      expect(row.content_hash).toBe(
        hashMemoryContent({ content: row.content })
      );
    }
  });

  test('memories and assertions follow the merged row', async () => {
    const memories = await selectRows<{ content_id: number }>({
      client,
      sql: 'SELECT content_id FROM memories ORDER BY id',
    });
    const assertions = await selectRows<{ content_id: number }>({
      client,
      sql: 'SELECT content_id FROM memory_assertions ORDER BY id',
    });

    expect(
      memories.map((m) => {
        return m.content_id;
      })
    ).toEqual([1, 1, 3, 4]);
    expect(
      assertions.map((a) => {
        return a.content_id;
      })
    ).toEqual([1, 1]);
  });

  test('a survivor with no vector takes the merged row’s', async () => {
    const [row] = await selectRows<{ embedding: string }>({
      client,
      sql: 'SELECT embedding::text FROM memory_contents WHERE id = 1',
    });

    expect(row.embedding).toBe('[1,2,3]');
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();

    const [{ count }] = await selectRows<{ count: string }>({
      client,
      sql: 'SELECT count(*)::text AS count FROM memory_contents',
    });
    expect(count).toBe('3');
  });
});
