import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner, initialize } from '@ttoss/postgresdb';

// `dist`, not `src`: the models carry decorated `declare` fields Babel's
// TypeScript transform rejects, and importing the package entry is also what
// proves the migrations are exported from it.
import { MIGRATIONS, models } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  createLegacySchema,
  dropDatabase,
  indexNames,
  selectRows,
  tableExists,
} from './migrationFixtures';

jest.setTimeout(180_000);

const databases: string[] = [];
let counter = 0;

const freshDatabase = async (): Promise<{
  client: Sequelize;
  name: string;
}> => {
  counter += 1;

  const name = `soat_migrations_${process.pid}_${counter}`;

  databases.push(name);

  return { client: await createDatabase(name), name };
};

const runnerFor = (args: { client: Sequelize; sync?: () => Promise<void> }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    sync: args.sync,
    log: () => {
      return undefined;
    },
  });
};

afterAll(async () => {
  for (const name of databases) {
    await dropDatabase(name);
  }
});

describe('the migration list', () => {
  test('every migration declares a probe, so no database needs baselining', () => {
    const withoutProbe = MIGRATIONS.filter((migration) => {
      return !migration.isApplied;
    }).map((migration) => {
      return migration.name;
    });

    expect(withoutProbe).toEqual([]);
  });

  test('names are unique and kebab-case', () => {
    const names = MIGRATIONS.map((migration) => {
      return migration.name;
    });

    expect(new Set(names).size).toBe(names.length);

    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test('every migration carries a description', () => {
    for (const migration of MIGRATIONS) {
      expect(typeof migration.description).toBe('string');
    }
  });
});

describe('memory-tags-to-jsonb', () => {
  let client: Sequelize;

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    await createLegacySchema({ client, tagsType: 'text[]' });

    await client.query(`
      INSERT INTO projects (public_id) VALUES ('proj_1');

      INSERT INTO memories (public_id, project_id, name, tags) VALUES
        ('mem_pair', 1, 'pair', ARRAY['role:manager']),
        ('mem_bare', 1, 'bare', ARRAY['customer']),
        ('mem_dup', 1, 'dup', ARRAY['a:b', 'a:c']),
        ('mem_colons', 1, 'colons', ARRAY['k:v:w']),
        ('mem_empty', 1, 'empty', ARRAY[]::text[]),
        ('mem_null', 1, 'null', NULL);

      INSERT INTO memory_entries (public_id, memory_id, content, tags) VALUES
        ('mem_entry_1', 1, 'entry', ARRAY['team:ops', 'urgent']);
    `);

    // By name: the rename that follows it would take both tables out from
    // under these assertions.
    await runnerFor({ client }).run({ names: ['memory-tags-to-jsonb'] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('both tag columns become jsonb', async () => {
    expect(
      await columnType({ client, table: 'memories', column: 'tags' })
    ).toBe('jsonb');
    expect(
      await columnType({ client, table: 'memory_entries', column: 'tags' })
    ).toBe('jsonb');
  });

  test('each documented conversion rule holds', async () => {
    const rows = await selectRows<{ public_id: string; tags: unknown }>({
      client,
      sql: 'SELECT public_id, tags FROM memories ORDER BY id',
    });

    expect(
      Object.fromEntries(
        rows.map((row) => {
          return [row.public_id, row.tags];
        })
      )
    ).toEqual({
      mem_pair: { role: 'manager' },
      mem_bare: { customer: '' },
      // Last element wins on a duplicate key.
      mem_dup: { a: 'c' },
      // Split on the FIRST colon, so a value keeps its own.
      mem_colons: { k: 'v:w' },
      mem_empty: {},
      mem_null: null,
    });
  });

  test('the item table converts too', async () => {
    const [row] = await selectRows<{ tags: unknown }>({
      client,
      sql: "SELECT tags FROM memory_entries WHERE public_id = 'mem_entry_1'",
    });

    expect(row.tags).toEqual({ team: 'ops', urgent: '' });
  });

  test('it is recorded in the ledger', async () => {
    const report = await runnerFor({ client }).status();

    const entry = report.migrations.find((migration) => {
      return migration.name === 'memory-tags-to-jsonb';
    });

    expect(entry?.applied).not.toBeNull();
    expect(entry?.applied?.baseline).toBe(false);
  });
});

describe('memories-rename-and-provenance', () => {
  let client: Sequelize;

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    await createLegacySchema({ client, tagsType: 'jsonb' });

    await client.query(`
      INSERT INTO projects (public_id) VALUES ('proj_1');
      INSERT INTO conversations (public_id) VALUES ('conv_abc'), ('conv_def');
      INSERT INTO generations (public_id) VALUES ('gen_xyz');

      INSERT INTO memories (public_id, project_id, name) VALUES
        ('mem_store_1', 1, 'store');

      INSERT INTO memory_entries
        (public_id, memory_id, content, source_type, source_conversation_id,
         source_generation_id)
      VALUES
        ('mem_entry_conv', 1, 'from a conversation', 'extraction', 1, 1),
        ('mem_entry_agent', 1, 'written by an agent', 'agent', NULL, 1),
        ('mem_entry_manual', 1, 'written by hand', 'manual', NULL, NULL),
        ('mem_entry_orch', 1, 'from an orchestration', 'orchestration', 2, NULL);

      UPDATE memory_entries SET superseded_by_entry_id = 3 WHERE id = 2;
    `);

    await runnerFor({ client }).run();
  });

  afterAll(async () => {
    await client.close();
  });

  test('the container vacates the name and the item takes it', async () => {
    expect(await tableExists({ client, table: 'memory_stores' })).toBe(true);
    expect(await tableExists({ client, table: 'memories' })).toBe(true);
    expect(await tableExists({ client, table: 'memory_entries' })).toBe(false);
  });

  test('the container keeps its rows and its public ids', async () => {
    const rows = await selectRows<{ public_id: string }>({
      client,
      sql: 'SELECT public_id FROM memory_stores ORDER BY id',
    });

    expect(rows).toEqual([{ public_id: 'mem_store_1' }]);
  });

  test('indexes follow their tables', async () => {
    expect(await indexNames({ client, table: 'memory_stores' })).toEqual([
      'memories_pkey',
      'memory_stores_public_id_unique',
    ]);

    expect(await indexNames({ client, table: 'memories' })).toEqual([
      'memories_embedding_hnsw_idx',
      'memories_public_id_unique',
      'memory_entries_pkey',
    ]);
  });

  test('the columns that named the old concepts are renamed', async () => {
    expect(
      await columnType({ client, table: 'memories', column: 'memory_store_id' })
    ).toBe('integer');
    expect(
      await columnType({
        client,
        table: 'memories',
        column: 'superseded_by_memory_id',
      })
    ).toBe('integer');
    expect(
      await columnType({ client, table: 'memories', column: 'memory_id' })
    ).toBeUndefined();
  });

  test('source_id holds the conversation public id', async () => {
    const rows = await selectRows<{
      public_id: string;
      source_type: string;
      source_id: string | null;
    }>({
      client,
      sql: `SELECT public_id, source_type, source_id FROM memories ORDER BY id`,
    });

    expect(rows).toEqual([
      {
        public_id: 'mem_entry_conv',
        source_type: 'conversation',
        source_id: 'conv_abc',
      },
      {
        public_id: 'mem_entry_agent',
        source_type: 'manual',
        source_id: null,
      },
      {
        public_id: 'mem_entry_manual',
        source_type: 'manual',
        source_id: null,
      },
      {
        public_id: 'mem_entry_orch',
        source_type: 'conversation',
        source_id: 'conv_def',
      },
    ]);
  });

  test('supersede pointers survive the rename', async () => {
    const rows = await selectRows<{ superseded_by_memory_id: number | null }>({
      client,
      sql: `SELECT superseded_by_memory_id FROM memories
             WHERE public_id = 'mem_entry_agent'`,
    });

    expect(rows).toEqual([{ superseded_by_memory_id: 3 }]);
  });

  test('the foreign keys the new model does not carry are gone', async () => {
    expect(
      await columnType({
        client,
        table: 'memories',
        column: 'source_conversation_id',
      })
    ).toBeUndefined();
    expect(
      await columnType({
        client,
        table: 'memories',
        column: 'source_generation_id',
      })
    ).toBeUndefined();
  });
});

describe('a database that already carries both changes', () => {
  let client: Sequelize;

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    await createLegacySchema({ client, tagsType: 'text[]' });
    await runnerFor({ client }).run();
  });

  afterAll(async () => {
    await client.close();
  });

  test('a second run applies nothing', async () => {
    const result = await runnerFor({ client }).run();

    expect(result.applied).toEqual([]);
    expect(result.detected).toEqual([]);
    expect(result.skipped).toEqual(
      MIGRATIONS.map((migration) => {
        return migration.name;
      })
    );
  });

  test('a run against a wiped ledger recognises its own work', async () => {
    await client.query('DELETE FROM schema_migrations');

    const result = await runnerFor({ client }).run();

    expect(result.applied).toEqual([]);
    expect(result.detected).toEqual(
      MIGRATIONS.map((migration) => {
        return migration.name;
      })
    );
  });
});

describe('a database `sync` has just built', () => {
  const name = `soat_migrations_sync_${process.pid}`;
  let client: Sequelize;

  beforeAll(async () => {
    databases.push(name);

    const db = await initialize({
      models,
      createVectorExtension: true,
      logging: false,
      database: (await createDatabase(name)) && name,
      username: process.env.TEST_DB_USERNAME ?? 'postgres',
      password: process.env.TEST_DB_PASSWORD ?? '',
      host: process.env.TEST_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.TEST_DB_PORT ?? 5432),
    });

    client = db.sequelize;

    await client.sync();
  });

  afterAll(async () => {
    await client.close();
  });

  test('every migration records itself without running', async () => {
    const result = await runnerFor({ client }).run();

    expect(result.applied).toEqual([]);
    expect(result.detected).toEqual(
      MIGRATIONS.map((migration) => {
        return migration.name;
      })
    );
  });

  test('the ledger marks them as baselined, not applied', async () => {
    const report = await runnerFor({ client }).status();

    for (const entry of report.migrations) {
      expect(entry.applied?.baseline).toBe(true);
    }

    expect(report.unknown).toEqual([]);
  });
});
