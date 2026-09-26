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

const NAME = '2026-09-26-usage-event-durable-public-ids';
const DATABASE = `soat_migration_usage_event_durable_ids_${process.pid}`;

const ENTITY_TABLES = [
  { table: 'orchestration_runs', column: 'orchestration_run_id', id: 'run' },
  { table: 'agents', column: 'agent_id', id: 'agt' },
  { table: 'actors', column: 'actor_id', id: 'act' },
  { table: 'sessions', column: 'session_id', id: 'ses' },
  { table: 'traces', column: 'trace_id', id: 'trc' },
  { table: 'ai_providers', column: 'ai_provider_id', id: 'aip' },
  { table: 'tools', column: 'tool_id', id: 'tool' },
];

const publicIdColumn = (column: string) => {
  return column.replace(/_id$/, '_public_id');
};

let client: Sequelize;

const runner = () => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: client,
    log: () => {
      return undefined;
    },
  });
};

const rowOf = async (idempotencyKey: string) => {
  const [row] = await selectRows<Record<string, string | null>>({
    client,
    sql: `SELECT * FROM usage_events WHERE idempotency_key = '${idempotencyKey}'`,
  });

  return row;
};

beforeAll(async () => {
  await startDatabaseServer();
  client = await createDatabase(DATABASE);

  await client.query(`
    ${ENTITY_TABLES.map(({ table, id }) => {
      return `
        CREATE TABLE ${table} (id serial PRIMARY KEY, public_id varchar(32) NOT NULL);
        INSERT INTO ${table} (public_id) VALUES ('${id}_live');`;
    }).join('\n')}

    CREATE TABLE usage_events (
      id serial PRIMARY KEY,
      ${ENTITY_TABLES.map(({ table, column }) => {
        return `${column} integer REFERENCES ${table} (id) ON DELETE SET NULL`;
      }).join(',\n')},
      idempotency_key varchar(255) NOT NULL
    );

    INSERT INTO usage_events (${ENTITY_TABLES.map(({ column }) => {
      return column;
    }).join(', ')}, idempotency_key)
      VALUES (1, 1, 1, 1, 1, 1, 1, 'attributed');
    INSERT INTO usage_events (agent_id, idempotency_key) VALUES (1, 'agent-only');
    INSERT INTO usage_events (idempotency_key) VALUES ('unattributed');
  `);

  await runner().run({ names: [NAME] });
});

afterAll(async () => {
  await client.close();
  await dropDatabase(DATABASE);
  await stopDatabaseServer();
});

describe(NAME, () => {
  test.each(ENTITY_TABLES)(
    '$column gains its public id column',
    async ({ column }) => {
      expect(
        await columnType({
          client,
          table: 'usage_events',
          column: publicIdColumn(column),
        })
      ).toBe('character varying');
    }
  );

  test('every set FK copies the public id of the row it points at', async () => {
    const row = await rowOf('attributed');

    for (const { column, id } of ENTITY_TABLES) {
      expect({ column, value: row[publicIdColumn(column)] }).toEqual({
        column,
        value: `${id}_live`,
      });
    }
  });

  test('a null FK leaves its public id null', async () => {
    const row = await rowOf('agent-only');

    expect(row.agent_public_id).toBe('agt_live');
    expect(row.tool_public_id).toBeNull();
    expect((await rowOf('unattributed')).agent_public_id).toBeNull();
  });

  test('re-running it is a no-op', async () => {
    const result = await runner().run({ names: [NAME] });

    expect(result.applied).toEqual([]);
  });
});
