import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import { createDatabase, dropDatabase, selectRows } from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_usage_event_model_aliases_${process.pid}`;
const NAME = '2026-11-18-usage-event-model-aliases';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

type Row = {
  id: number;
  model: string;
  provider: string;
  cost_usd: string;
  quantity: string;
  created_at: Date;
  updated_at: Date;
};

const ALIASES = JSON.stringify({
  sonnet: 'anthropic.claude-sonnet-v1',
  haiku: 'anthropic.claude-haiku-v1',
  'opus-a': 'vendor-opus',
  'opus-b': 'vendor-opus',
  'anthropic.claude-legacy': 'anthropic.claude-legacy-v2',
  legacy: 'anthropic.claude-legacy',
});

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;
  let before: Row[];

  const rows = async () => {
    return selectRows<Row>({
      client,
      sql: `SELECT id, model, provider, cost_usd::text AS cost_usd,
              quantity::text AS quantity, created_at, updated_at
            FROM usage_events ORDER BY id`,
    });
  };

  const modelOf = async (id: number) => {
    return (await rows()).find((row) => {
      return row.id === id;
    })?.model;
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE ai_providers (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        model_aliases json
      );
      CREATE TABLE usage_events (
        id serial PRIMARY KEY,
        ai_provider_id integer REFERENCES ai_providers (id) ON DELETE SET NULL,
        provider varchar(255) NOT NULL,
        model varchar(255) NOT NULL,
        cost_usd decimal,
        quantity decimal NOT NULL,
        created_at timestamptz NOT NULL DEFAULT '2026-01-01',
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
      );

      INSERT INTO ai_providers (id, public_id, model_aliases) VALUES
        (1, 'aip_aliased', '${ALIASES}'),
        (2, 'aip_plain', NULL),
        (3, 'aip_empty', '{}');

      INSERT INTO usage_events (id, ai_provider_id, provider, model, cost_usd, quantity) VALUES
        (1, 1, 'bedrock', 'anthropic.claude-sonnet-v1', 0.12, 1000),
        (2, 1, 'bedrock', 'anthropic.claude-haiku-v1', 0.01, 200),
        (3, 1, 'bedrock', 'sonnet', 0.12, 1000),
        (4, 1, 'bedrock', 'vendor-unaliased', 0.5, 10),
        (5, 1, 'bedrock', 'vendor-opus', 0.9, 30),
        (6, 1, 'bedrock', 'anthropic.claude-legacy', 0.3, 30),
        (7, 2, 'anthropic', 'anthropic.claude-sonnet-v1', 0.12, 1000),
        (8, 3, 'anthropic', 'anthropic.claude-sonnet-v1', 0.12, 1000),
        (9, NULL, 'bedrock', 'anthropic.claude-sonnet-v1', 0.12, 1000);
    `);

    before = await rows();
    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('an event under the one vendor id an alias targets takes that alias', async () => {
    expect(await modelOf(1)).toBe('sonnet');
    expect(await modelOf(2)).toBe('haiku');
  });

  test('an event under an id no alias targets, or two aliases target, is unchanged', async () => {
    expect(await modelOf(4)).toBe('vendor-unaliased');
    expect(await modelOf(5)).toBe('vendor-opus');
  });

  test('an event already under an alias is unchanged, even when another alias targets it', async () => {
    expect(await modelOf(3)).toBe('sonnet');
    expect(await modelOf(6)).toBe('anthropic.claude-legacy');
  });

  test('an event of a provider without aliases, or of no provider, is unchanged', async () => {
    for (const id of [7, 8, 9]) {
      expect(await modelOf(id)).toBe('anthropic.claude-sonnet-v1');
    }
  });

  test('no column but model changes', async () => {
    const after = await rows();
    expect(
      after.map(({ model: _model, ...rest }) => {
        return rest;
      })
    ).toEqual(
      before.map(({ model: _model, ...rest }) => {
        return rest;
      })
    );
  });

  test('a second run changes nothing', async () => {
    const once = await rows();
    await client.query(`DELETE FROM schema_migrations WHERE name = '${NAME}'`);
    await runnerFor({ client }).run({ names: [NAME] });
    expect(await rows()).toEqual(once);
  });
});
