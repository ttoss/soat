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

const DATABASE = `soat_migration_webhook_policy_ids_${process.pid}`;
const NAME = '2026-11-10-webhook-policy-ids';

const documentOf = (statement: object[]): string => {
  return JSON.stringify({ statement });
};

const POLICIES: [string, string][] = [
  [
    'pol_filter',
    documentOf([
      { effect: 'Allow', action: ['*'], resource: ['srn:p:file:*'] },
      { effect: 'Allow', action: ['files:GetFile'] },
    ]),
  ],
  ['pol_deny', documentOf([{ effect: 'Deny', action: ['*'] }])],
  [
    'pol_types',
    documentOf([{ effect: 'Allow', action: ['files.*'], resource: ['*'] }]),
  ],
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

  type WebhookRow = {
    policy_ids: string[] | null;
    event_resources: string[] | null;
    event_data: unknown;
  };

  const webhook = async (publicId: string): Promise<WebhookRow> => {
    const [row] = await selectRows<WebhookRow>({
      client,
      sql: `SELECT policy_ids, event_resources, event_data FROM webhooks WHERE public_id = '${publicId}'`,
    });
    return row;
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    const policyValues = POLICIES.map(([publicId, document]) => {
      return `('${publicId}', '${document}')`;
    }).join(', ');

    await client.query(`
      CREATE TABLE policies (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        document json NOT NULL);
      CREATE TABLE webhooks (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        project_id integer NOT NULL,
        policy_id integer REFERENCES policies (id) ON DELETE SET NULL,
        name varchar(255) NOT NULL,
        events varchar(255)[] NOT NULL);
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
      INSERT INTO webhooks (public_id, project_id, policy_id, name, events)
      VALUES
        ('wh_open', 1, NULL, 'a', '{*}'),
        ('wh_filter', 1, 1, 'b', '{files.*}'),
        ('wh_deny', 1, 2, 'c', '{*}'),
        ('wh_types', 1, 3, 'd', '{*}');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a webhook with no filter policy matches any resource', async () => {
    expect(await webhook('wh_open')).toEqual({
      policy_ids: [],
      event_resources: null,
      event_data: null,
    });
  });

  test('a filter policy becomes the resources its * statements allow', async () => {
    expect((await webhook('wh_filter')).event_resources).toEqual([
      'srn:p:file:*',
    ]);
  });

  test.each(['wh_deny', 'wh_types'])(
    '%s, a filter no resource list expresses, converts to matching nothing',
    async (publicId) => {
      expect((await webhook(publicId)).event_resources).toEqual([]);
    }
  );

  test('every webhook is filed for review: no creator is recorded to grant it', async () => {
    const rows = await selectRows<{ detail: { webhook_id: string } }>({
      client,
      sql: `SELECT detail FROM exception_items WHERE kind = 'manual' ORDER BY id`,
    });

    expect(
      rows.map((row) => {
        return row.detail.webhook_id;
      })
    ).toEqual(['wh_open', 'wh_filter', 'wh_deny', 'wh_types']);
  });

  test('policy_id is gone; policy_ids is jsonb', async () => {
    expect(
      await columnType({ client, table: 'webhooks', column: 'policy_id' })
    ).toBeUndefined();
    expect(
      await columnType({ client, table: 'webhooks', column: 'policy_ids' })
    ).toBe('jsonb');
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.applied).toEqual([]);
  });
});

describe(`${NAME} on a database that predates the table`, () => {
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
