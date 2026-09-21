import { createHash } from 'node:crypto';

import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner, initialize } from '@ttoss/postgresdb';

// `dist`, not `src`: the models carry decorated `declare` fields Babel's
// TypeScript transform rejects, and importing the package entry is also what
// proves the migrations are exported from it.
import { MIGRATIONS, models } from '../../../dist/index.cjs';
import {
  columnType,
  countRows,
  createDatabase,
  createEmptyDatabase,
  createLegacySchema,
  databaseConnection,
  dropDatabase,
  indexNames,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
  tableExists,
} from './migrationFixtures';

jest.setTimeout(180_000);

/** `YYYY-MM-DD-<kebab-case>`, the name a migration is recorded under. */
const DATED_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

beforeAll(async () => {
  await startDatabaseServer();
});

afterAll(async () => {
  for (const name of databases) {
    await dropDatabase(name);
  }

  await stopDatabaseServer();
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

  test('names are unique', () => {
    const names = MIGRATIONS.map((migration) => {
      return migration.name;
    });

    expect(new Set(names).size).toBe(names.length);
  });

  test('every name carries its date as a prefix', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.name).toMatch(DATED_NAME);
    }
  });

  test('the list is in date order, so reading order is execution order', () => {
    // The prefix earns its keep only if it agrees with the array, which is what
    // actually decides the order the runner applies them in.
    const dates = MIGRATIONS.map((migration) => {
      return DATED_NAME.exec(migration.name)?.[1];
    });

    expect(dates).toEqual([...dates].sort());
  });

  test('every migration carries a description', () => {
    for (const migration of MIGRATIONS) {
      expect(typeof migration.description).toBe('string');
    }
  });
});

describe('2026-09-11-memory-tags-to-jsonb', () => {
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
    await runnerFor({ client }).run({
      names: ['2026-09-11-memory-tags-to-jsonb'],
    });
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
      return migration.name === '2026-09-11-memory-tags-to-jsonb';
    });

    expect(entry?.applied).not.toBeNull();
    expect(entry?.applied?.baseline).toBe(false);
  });
});

describe('2026-09-16-memories-rename-and-provenance', () => {
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

    // By name, and stopping here: the migration that follows moves the text and
    // the vector off `memories`, which would take the index and column
    // assertions below out from under this suite.
    await runnerFor({ client }).run({
      names: [
        '2026-09-11-memory-tags-to-jsonb',
        '2026-09-16-memories-rename-and-provenance',
      ],
    });
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

describe('2026-09-16-memory-assertions-and-shared-content', () => {
  let client: Sequelize;

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    await createLegacySchema({ client, tagsType: 'jsonb' });

    await client.query(`
      INSERT INTO projects (public_id) VALUES ('proj_1');

      INSERT INTO memories (public_id, project_id, name) VALUES
        ('mem_store_1', 1, 'first store'),
        ('mem_store_2', 1, 'second store');

      -- Three rows whose text is the same once normalized, in one store: they
      -- must collapse to a single content row. The oldest carries the vector,
      -- and the newest a different one, so which vector survives is visible.
      INSERT INTO memory_entries (public_id, memory_id, content, embedding, created_at)
      VALUES
        ('mem_entry_old', 1, 'Customer prefers email',
         array_fill(0.25::real, ARRAY[1024])::vector, now() - interval '2 hours'),
        ('mem_entry_mid', 1, 'Customer prefers email', NULL, now() - interval '1 hour'),
        ('mem_entry_spaced', 1, '  Customer   prefers email  ',
         array_fill(0.75::real, ARRAY[1024])::vector, now()),
        ('mem_entry_other', 1, 'Fiscal year ends in December', NULL, now()),
        -- The same text again, in the other store: stores never share a row.
        ('mem_entry_cross', 2, 'Customer prefers email', NULL, now());
    `);

    await runnerFor({ client }).run();
  });

  afterAll(async () => {
    await client.close();
  });

  test('identical texts in one store collapse to a single content row', async () => {
    const rows = await selectRows<{ content: string; memories: string }>({
      client,
      sql: `SELECT mc.content, count(m.id)::text AS memories
              FROM memory_contents mc
              JOIN memories m ON m.content_id = mc.id
             WHERE mc.memory_store_id = 1
             GROUP BY mc.id, mc.content
             ORDER BY mc.content`,
    });

    expect(rows).toEqual([
      { content: 'Customer prefers email', memories: '3' },
      { content: 'Fiscal year ends in December', memories: '1' },
    ]);
  });

  // The migration's hash must agree with `hashMemoryContent` in the server, or
  // a text written before the cutover and restated after it would be two rows.
  test('the hash is over trimmed, whitespace-collapsed content', async () => {
    const [row] = await selectRows<{ content_hash: string }>({
      client,
      sql: `SELECT content_hash FROM memory_contents
             WHERE memory_store_id = 1 AND content = 'Customer prefers email'`,
    });

    expect(row.content_hash).toBe(
      createHash('sha256').update('Customer prefers email').digest('hex')
    );
  });

  // An older vector was produced by the model the rest of the corpus was
  // embedded with, so keeping it is what leaves distances comparable.
  test('the oldest row of a collapsed group keeps its vector', async () => {
    const [row] = await selectRows<{ oldest: boolean; newest: boolean }>({
      client,
      sql: `SELECT embedding = array_fill(0.25::real, ARRAY[1024])::vector AS oldest,
                   embedding = array_fill(0.75::real, ARRAY[1024])::vector AS newest
              FROM memory_contents
             WHERE memory_store_id = 1 AND content = 'Customer prefers email'`,
    });

    expect(row).toEqual({ oldest: true, newest: false });
  });

  test('the same text in another store is its own row', async () => {
    const rows = await selectRows<{ memory_store_id: number }>({
      client,
      sql: `SELECT memory_store_id FROM memory_contents
             WHERE content = 'Customer prefers email'
             ORDER BY memory_store_id`,
    });

    expect(rows).toEqual([{ memory_store_id: 1 }, { memory_store_id: 2 }]);
  });

  test('every memory points at a content row', async () => {
    expect(
      await countRows({
        client,
        sql: 'SELECT count(*) FROM memories WHERE content_id IS NULL',
      })
    ).toBe(0);
  });

  test('the per-memory text and vector are gone', async () => {
    expect(
      await columnType({ client, table: 'memories', column: 'content' })
    ).toBeUndefined();
    expect(
      await columnType({ client, table: 'memories', column: 'embedding' })
    ).toBeUndefined();
  });

  // A write made before the ledger exists leaves no row and no trace, so there
  // is nothing to backfill it from.
  test('the assertion ledger is created empty', async () => {
    expect(await tableExists({ client, table: 'memory_assertions' })).toBe(
      true
    );
    expect(
      await countRows({
        client,
        sql: 'SELECT count(*) FROM memory_assertions',
      })
    ).toBe(0);
  });
});

describe('2026-09-16-memory-rules-from-agent-extraction', () => {
  let client: Sequelize;

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    await createLegacySchema({ client, tagsType: 'jsonb' });

    await client.query(`
      INSERT INTO projects (public_id) VALUES ('proj_1');
      INSERT INTO ai_providers (public_id) VALUES ('aip_cheap');

      INSERT INTO memories (public_id, project_id, name) VALUES
        ('mstore_support', 1, 'support facts'),
        ('mstore_billing', 1, 'billing facts');

      INSERT INTO agents (public_id, knowledge_config) VALUES
        ('agent_plain', '{"write_memory_store_id": "mstore_support", "extraction": true}'),
        ('agent_tuned', '{"write_memory_store_id": "mstore_billing", "extraction": {"prompt": "Only billing facts", "model": "cheap-model", "ai_provider_id": "aip_cheap"}}'),
        ('agent_off', '{"write_memory_store_id": "mstore_support", "extraction": {"enabled": false}}'),
        ('agent_no_store', '{"extraction": true}'),
        ('agent_reader', '{"memory_store_ids": ["mstore_support"]}');

      INSERT INTO agent_versions (agent_id, config) VALUES
        (1, '{"model": "a-model", "knowledge_config": {"write_memory_store_id": "mstore_support", "extraction": true}}');
    `);

    await runnerFor({ client }).run();
  });

  afterAll(async () => {
    await client.close();
  });

  test('each enabled extraction config becomes one rule on its write store', async () => {
    const rows = await selectRows<{
      store: string;
      on: string;
      source_agent_ids: unknown;
      agent_id: number | null;
      tool_id: number | null;
      enabled: boolean;
    }>({
      client,
      sql: `SELECT ms.public_id AS store, mr."on", mr.source_agent_ids,
                   mr.agent_id, mr.tool_id, mr.enabled
              FROM memory_rules mr
              JOIN memory_stores ms ON ms.id = mr.memory_store_id
             ORDER BY ms.public_id`,
    });

    expect(rows).toEqual([
      {
        store: 'mstore_billing',
        on: 'agents.generation.completed',
        source_agent_ids: ['agent_tuned'],
        // No handler: the built-in extractor, relocated.
        agent_id: null,
        tool_id: null,
        enabled: true,
      },
      {
        store: 'mstore_support',
        on: 'agents.generation.completed',
        source_agent_ids: ['agent_plain'],
        agent_id: null,
        tool_id: null,
        enabled: true,
      },
    ]);
  });

  test("the object form's overrides move across field for field", async () => {
    const [row] = await selectRows<{
      prompt: string | null;
      model: string | null;
      provider: string | null;
    }>({
      client,
      sql: `SELECT mr.prompt, mr.model, aip.public_id AS provider
              FROM memory_rules mr
              LEFT JOIN ai_providers aip ON aip.id = mr.ai_provider_id
             WHERE mr.source_agent_ids = '["agent_tuned"]'::jsonb`,
    });

    expect(row).toEqual({
      prompt: 'Only billing facts',
      model: 'cheap-model',
      provider: 'aip_cheap',
    });
  });

  test('every public id is a well-formed mrule_ id', async () => {
    const rows = await selectRows<{ public_id: string }>({
      client,
      sql: 'SELECT public_id FROM memory_rules',
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.public_id).toMatch(/^mrule_[A-Za-z0-9]{16}$/);
    }
  });

  test('the field is stripped from every agent and every version', async () => {
    expect(
      await countRows({
        client,
        sql: `SELECT count(*) FROM agents WHERE knowledge_config ? 'extraction'`,
      })
    ).toBe(0);
    expect(
      await countRows({
        client,
        sql: `SELECT count(*) FROM agent_versions
               WHERE config -> 'knowledge_config' ? 'extraction'`,
      })
    ).toBe(0);
  });

  test('the rest of the knowledge config is left alone', async () => {
    const [row] = await selectRows<{ knowledge_config: unknown }>({
      client,
      sql: `SELECT knowledge_config FROM agents WHERE public_id = 'agent_plain'`,
    });

    expect(row.knowledge_config).toEqual({
      write_memory_store_id: 'mstore_support',
    });
  });

  test('the assertion ledger gains its foreign key', async () => {
    const [row] = await selectRows<{ delete_rule: string }>({
      client,
      sql: `SELECT confdeltype AS delete_rule FROM pg_constraint
             WHERE conname = 'memory_assertions_rule_id_fkey'`,
    });

    // 'n' is ON DELETE SET NULL: deleting a rule must not erase its writes.
    expect(row?.delete_rule).toBe('n');
  });

  test('a second run inserts no duplicate rules', async () => {
    await client.query('DELETE FROM schema_migrations');
    await runnerFor({ client }).run();

    expect(
      await countRows({ client, sql: 'SELECT count(*) FROM memory_rules' })
    ).toBe(2);
  });
});

describe('a database that already carries every change', () => {
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

    await createEmptyDatabase(name);

    const db = await initialize({
      models,
      createVectorExtension: true,
      logging: false,
      database: name,
      ...databaseConnection(),
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

describe('2026-09-21-durable-event-firings', () => {
  let client: Sequelize;

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    // The firing table as it stands before the change: a row that records what
    // happened, with nothing that says who owns finishing it.
    await client.query(`
      CREATE TABLE trigger_firings (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        trigger_id integer NOT NULL,
        project_id integer NOT NULL,
        source varchar(255) NOT NULL,
        status varchar(255) NOT NULL,
        input jsonb,
        result jsonb,
        error jsonb,
        started_at timestamp with time zone,
        completed_at timestamp with time zone,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      );

      INSERT INTO trigger_firings (public_id, trigger_id, project_id, source, status)
        VALUES ('trg_fire_old', 1, 1, 'event', 'succeeded');
    `);

    await runnerFor({ client }).run({
      names: ['2026-09-21-durable-event-firings'],
    });
  });

  afterAll(async () => {
    await client.close();
  });

  test('the durability columns exist', async () => {
    expect(
      await columnType({
        client,
        table: 'trigger_firings',
        column: 'idempotency_key',
      })
    ).toBe('character varying');
    expect(
      await columnType({
        client,
        table: 'trigger_firings',
        column: 'causation_chain',
      })
    ).toBe('jsonb');
    expect(
      await columnType({ client, table: 'trigger_firings', column: 'attempts' })
    ).toBe('integer');
    expect(
      await columnType({
        client,
        table: 'trigger_firings',
        column: 'lease_expires_at',
      })
    ).toBe('timestamp with time zone');
  });

  /**
   * A firing written before the change had no key, no stored chain and nothing
   * holding it — which is what those values say, so it is left as it is rather
   * than backfilled into a shape it never had.
   */
  test('a firing written before the change reads as unclaimed', async () => {
    const [row] = await selectRows<{
      idempotency_key: string | null;
      causation_chain: unknown;
      attempts: number;
      lease_expires_at: Date | null;
    }>({
      client,
      sql: `SELECT idempotency_key, causation_chain, attempts, lease_expires_at
              FROM trigger_firings WHERE public_id = 'trg_fire_old'`,
    });

    expect(row.idempotency_key).toBeNull();
    expect(row.causation_chain).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.lease_expires_at).toBeNull();
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor({ client }).run({
      names: ['2026-09-21-durable-event-firings'],
    });

    expect(result.applied).toEqual([]);
  });
});
