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

const DATABASE = `soat_migration_trigger_policy_ids_${process.pid}`;
const NAME = '2026-11-10-trigger-policy-ids';

const documentOf = (statement: object[]): string => {
  return JSON.stringify({ statement });
};

const POLICIES: [string, string][] = [
  ['pol_held', documentOf([{ effect: 'Allow', action: ['files:*'] }])],
  [
    'pol_filter',
    documentOf([
      { effect: 'Allow', action: ['*'], resource: ['srn:p:document:*'] },
      { effect: 'Allow', action: ['files:GetFile'] },
    ]),
  ],
  ['pol_deny', documentOf([{ effect: 'Deny', action: ['*'] }])],
  ['pol_user', documentOf([{ effect: 'Allow', action: ['agents:*'] }])],
];

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

  type TriggerRow = {
    policy_ids: string[] | null;
    events: string[] | null;
    event_resources: string[] | null;
  };

  const trigger = async (publicId: string): Promise<TriggerRow> => {
    const [row] = await selectRows<TriggerRow>({
      client,
      sql: `SELECT policy_ids, events, event_resources FROM triggers WHERE public_id = '${publicId}'`,
    });
    return row;
  };

  const reviews = (): Promise<{ title: string; detail: unknown }[]> => {
    return selectRows({
      client,
      sql: `SELECT title, detail FROM exception_items WHERE kind = 'manual' ORDER BY id`,
    });
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    const policyValues = POLICIES.map(([publicId, document]) => {
      return `('${publicId}', '${document}')`;
    }).join(', ');

    await client.query(`
      CREATE TYPE role_enum AS ENUM ('admin', 'user');
      CREATE TABLE policies (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        name varchar(255),
        document json NOT NULL,
        created_at timestamptz,
        updated_at timestamptz);
      CREATE TABLE users (
        id serial PRIMARY KEY,
        role role_enum NOT NULL,
        policy_ids integer[] NOT NULL DEFAULT '{}');
      CREATE TABLE triggers (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        project_id integer NOT NULL,
        created_by_user_id integer,
        policy_id integer REFERENCES policies (id),
        name varchar(255) NOT NULL,
        type varchar(255) NOT NULL,
        event_pattern varchar(255));
      CREATE TABLE trigger_firings (id serial PRIMARY KEY);
      CREATE TABLE exception_items (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        project_id integer NOT NULL,
        status varchar(32) NOT NULL,
        severity varchar(32) NOT NULL,
        kind varchar(32) NOT NULL,
        title text NOT NULL,
        detail json,
        dedup_key varchar(255),
        occurrence_count integer NOT NULL,
        last_seen_at timestamptz,
        created_at timestamptz,
        updated_at timestamptz);

      INSERT INTO policies (public_id, document) VALUES ${policyValues};
      INSERT INTO users (role, policy_ids) VALUES
        ('admin', '{}'), ('user', '{1,4}'), ('user', '{1,3}');
      INSERT INTO triggers
        (public_id, project_id, created_by_user_id, policy_id, name, type, event_pattern)
      VALUES
        ('trg_admin_open', 1, 1, NULL, 'a', 'schedule', NULL),
        ('trg_admin_bound', 1, 1, 1, 'b', 'manual', NULL),
        ('trg_user_open', 1, 2, NULL, 'c', 'manual', NULL),
        ('trg_user_held', 1, 2, 1, 'd', 'manual', NULL),
        ('trg_user_unheld', 1, 2, 2, 'e', 'manual', NULL),
        ('trg_user_denies', 1, 3, 1, 'f', 'manual', NULL),
        ('trg_orphan', 1, NULL, NULL, 'g', 'manual', NULL),
        ('trg_event_open', 1, 1, NULL, 'h', 'event', 'documents.*'),
        ('trg_event_filter', 1, 1, 2, 'i', 'event', '*'),
        ('trg_event_deny', 1, 1, 3, 'j', 'event', '*');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('an admin creator with no policy acts under a new allow-all policy', async () => {
    const { policy_ids: policyIds } = await trigger('trg_admin_open');
    const [created] = await selectRows<{ document: unknown }>({
      client,
      sql: `SELECT document FROM policies WHERE public_id = '${policyIds?.[0]}'`,
    });

    expect(policyIds).toHaveLength(1);
    expect(created.document).toEqual({
      statement: [{ effect: 'Allow', action: ['*'] }],
    });
  });

  test('an admin creator keeps the trigger policy', async () => {
    expect((await trigger('trg_admin_bound')).policy_ids).toEqual(['pol_held']);
  });

  test("a user creator with no policy acts under the creator's policies", async () => {
    expect((await trigger('trg_user_open')).policy_ids).toEqual([
      'pol_held',
      'pol_user',
    ]);
  });

  test('a user creator holding the policy keeps it', async () => {
    expect((await trigger('trg_user_held')).policy_ids).toEqual(['pol_held']);
  });

  test.each(['trg_user_unheld', 'trg_user_denies', 'trg_orphan'])(
    '%s converts to no policies',
    async (publicId) => {
      expect((await trigger(publicId)).policy_ids).toEqual([]);
    }
  );

  test('an event pattern becomes the events list', async () => {
    expect(await trigger('trg_event_open')).toEqual({
      policy_ids: expect.any(Array),
      events: ['documents.*'],
      event_resources: null,
    });
  });

  test('an event filter policy becomes the resources its * statements allow', async () => {
    expect((await trigger('trg_event_filter')).event_resources).toEqual([
      'srn:p:document:*',
    ]);
  });

  test('a filter with a Deny converts to matching nothing', async () => {
    expect((await trigger('trg_event_deny')).event_resources).toEqual([]);
  });

  test('every trigger left matching or allowing nothing is filed for review', async () => {
    const rows = await reviews();

    expect(
      rows.map((row) => {
        return (row.detail as { trigger_id: string }).trigger_id;
      })
    ).toEqual([
      'trg_user_unheld',
      'trg_user_denies',
      'trg_orphan',
      'trg_event_deny',
    ]);
  });

  test('policy_id and event_pattern are gone; firings carry acted_as', async () => {
    expect(
      await columnType({ client, table: 'triggers', column: 'policy_id' })
    ).toBeUndefined();
    expect(
      await columnType({ client, table: 'triggers', column: 'event_pattern' })
    ).toBeUndefined();
    expect(
      await columnType({ client, table: 'triggers', column: 'policy_ids' })
    ).toBe('jsonb');
    expect(
      await columnType({
        client,
        table: 'trigger_firings',
        column: 'acted_as_principal_id',
      })
    ).toBe('character varying');
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.applied).toEqual([]);
  });
});

describe(`${NAME} on a database that predates the tables`, () => {
  const EMPTY = `${DATABASE}_empty`;
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(EMPTY);
  });

  afterAll(async () => {
    await client.close();
    await dropDatabase(EMPTY);
  });

  test('it records itself without running', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.detected).toEqual([NAME]);
  });
});
