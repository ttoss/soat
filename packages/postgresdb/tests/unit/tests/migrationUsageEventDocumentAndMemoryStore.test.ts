import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  indexNames,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_usage_event_subject_${process.pid}`;
const NAME = '2026-09-26-usage-event-document-and-memory-store';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
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

  const subjectOf = async (idempotencyKey: string) => {
    const [row] = await selectRows<{
      document_id: number | null;
      memory_store_id: number | null;
    }>({
      client,
      sql: `SELECT document_id, memory_store_id FROM usage_events WHERE idempotency_key = '${idempotencyKey}'`,
    });
    return row;
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE documents (id serial PRIMARY KEY);
      CREATE TABLE memory_stores (id serial PRIMARY KEY);
      CREATE TABLE usage_events (
        id serial PRIMARY KEY,
        idempotency_key varchar(255) NOT NULL
      );

      INSERT INTO documents DEFAULT VALUES;
      INSERT INTO memory_stores DEFAULT VALUES;
      INSERT INTO usage_events (idempotency_key)
        VALUES ('embedding:11111111-1111-1111-1111-111111111111');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('both columns exist, indexed', async () => {
    expect(
      await columnType({ client, table: 'usage_events', column: 'document_id' })
    ).toBe('integer');
    expect(
      await columnType({
        client,
        table: 'usage_events',
        column: 'memory_store_id',
      })
    ).toBe('integer');
    expect(await indexNames({ client, table: 'usage_events' })).toEqual(
      expect.arrayContaining([
        'usage_events_document_id_idx',
        'usage_events_memory_store_id_idx',
      ])
    );
  });

  test('an existing event names no subject — nothing records what it embedded', async () => {
    expect(
      await subjectOf('embedding:11111111-1111-1111-1111-111111111111')
    ).toEqual({ document_id: null, memory_store_id: null });
  });

  test('deleting the subject keeps the event and nulls its column', async () => {
    await client.query(`
      INSERT INTO usage_events (idempotency_key, document_id, memory_store_id)
        VALUES ('embedding:22222222-2222-2222-2222-222222222222', 1, 1);
      DELETE FROM documents WHERE id = 1;
      DELETE FROM memory_stores WHERE id = 1;
    `);

    expect(
      await subjectOf('embedding:22222222-2222-2222-2222-222222222222')
    ).toEqual({ document_id: null, memory_store_id: null });
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
