import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_usage_event_generation_${process.pid}`;

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const freshDatabase = async (): Promise<{ client: Sequelize }> => {
  return { client: await createDatabase(DATABASE) };
};

beforeAll(async () => {
  await startDatabaseServer();
});

afterAll(async () => {
  await dropDatabase(DATABASE);
  await stopDatabaseServer();
});

describe('2026-09-25-usage-event-generation-public-id', () => {
  const NAME = '2026-09-25-usage-event-generation-public-id';
  let client: Sequelize;

  const publicIdOf = async (idempotencyKey: string) => {
    const [row] = await selectRows<{ generation_public_id: string | null }>({
      client,
      sql: `SELECT generation_public_id FROM usage_events WHERE idempotency_key = '${idempotencyKey}'`,
    });

    return row.generation_public_id;
  };

  beforeAll(async () => {
    ({ client } = await freshDatabase());

    await client.query(`
      CREATE TABLE generations (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL
      );

      CREATE TABLE usage_events (
        id serial PRIMARY KEY,
        generation_id integer REFERENCES generations (id) ON DELETE SET NULL,
        meter_type varchar(255) NOT NULL,
        idempotency_key varchar(255) NOT NULL
      );

      INSERT INTO generations (public_id)
        VALUES ('gen_liveAAAAAAAAAAAA'), ('gen_runNodeAAAAAAAA');

      INSERT INTO usage_events (generation_id, meter_type, idempotency_key) VALUES
        (1, 'llm_tokens', 'gen_liveAAAAAAAAAAAA'),
        (1, 'tool_execution', 'tool:11111111-1111-1111-1111-111111111111'),
        (2, 'llm_tokens', 'run:run_AAAAAAAAAAAAAAAA:node:a:attempt:1'),
        (NULL, 'llm_tokens', 'gen_goneAAAAAAAAAAAA'),
        (NULL, 'llm_tokens', 'gen_goneBBBBBBBBBBBB:step:2'),
        (NULL, 'llm_tokens', 'run:run_BBBBBBBBBBBBBBBB:node:b:attempt:1'),
        (NULL, 'llm_tokens', 'completion:chat:22222222-2222-2222-2222-222222222222');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('the column exists', async () => {
    expect(
      await columnType({
        client,
        table: 'usage_events',
        column: 'generation_public_id',
      })
    ).toBe('character varying');
  });

  test('an event whose generation exists copies its public id', async () => {
    expect(await publicIdOf('gen_liveAAAAAAAAAAAA')).toBe(
      'gen_liveAAAAAAAAAAAA'
    );
    expect(await publicIdOf('tool:11111111-1111-1111-1111-111111111111')).toBe(
      'gen_liveAAAAAAAAAAAA'
    );
    expect(await publicIdOf('run:run_AAAAAAAAAAAAAAAA:node:a:attempt:1')).toBe(
      'gen_runNodeAAAAAAAA'
    );
  });

  test('a deleted standalone generation is read back from the key', async () => {
    expect(await publicIdOf('gen_goneAAAAAAAAAAAA')).toBe(
      'gen_goneAAAAAAAAAAAA'
    );
    expect(await publicIdOf('gen_goneBBBBBBBBBBBB:step:2')).toBe(
      'gen_goneBBBBBBBBBBBB'
    );
  });

  test('a key that names no generation leaves the column null', async () => {
    expect(
      await publicIdOf('run:run_BBBBBBBBBBBBBBBB:node:b:attempt:1')
    ).toBeNull();
    expect(
      await publicIdOf('completion:chat:22222222-2222-2222-2222-222222222222')
    ).toBeNull();
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });

    expect(result.applied).toEqual([]);
  });
});
