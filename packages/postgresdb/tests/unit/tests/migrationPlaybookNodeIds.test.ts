import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_playbook_node_ids_${process.pid}`;
const NAME = '2026-10-17-playbook-node-ids';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const OLD_DEFINITION = {
  nodes: [
    {
      key: 'revenue',
      title: 'Revenue',
      kind: 'collect',
      final: false,
      inputs: [
        {
          name: 'amount',
          schema: { type: 'number' },
          required: true,
          source: 'manual',
        },
      ],
    },
    {
      key: 'pricing',
      title: 'Pricing',
      kind: 'collect',
      final: true,
      inputs: [
        {
          name: 'revenue',
          schema: {},
          required: true,
          source: { node: 'revenue', field: 'output.amount' },
        },
      ],
    },
  ],
};

const NEW_DEFINITION = {
  nodes: [
    { ...OLD_DEFINITION.nodes[0], key: undefined, id: 'revenue' },
    {
      ...OLD_DEFINITION.nodes[1],
      key: undefined,
      id: 'pricing',
      inputs: [
        {
          ...OLD_DEFINITION.nodes[1].inputs[0],
          source: { node_id: 'revenue', field: 'output.amount' },
        },
      ],
    },
  ],
};

const OLD_DIFF = {
  added: ['contact'],
  removed: [],
  changed: [{ node: 'pricing', executor: false, inputs: [] }],
};

type Definition = { nodes: Array<Record<string, unknown>> };

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

    const definition = JSON.stringify(OLD_DEFINITION);
    await client.query(`
      CREATE TABLE playbooks (
        id serial PRIMARY KEY,
        definition json NOT NULL
      );
      CREATE TABLE playbook_versions (
        id serial PRIMARY KEY,
        config json NOT NULL
      );
      CREATE TABLE playbook_upgrades (
        id serial PRIMARY KEY,
        diff jsonb NOT NULL
      );

      INSERT INTO playbooks (definition) VALUES ('${definition}');
      INSERT INTO playbook_versions (config)
        VALUES ('{"definition": ${definition}, "label": "v1"}');
      INSERT INTO playbook_upgrades (diff)
        VALUES ('${JSON.stringify(OLD_DIFF)}');
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a definition names each node by id and each source by node_id', async () => {
    const [row] = await selectRows<{ definition: Definition }>({
      client,
      sql: 'SELECT definition FROM playbooks',
    });

    expect(row.definition).toEqual(NEW_DEFINITION);
  });

  test('a node keeps its field order', async () => {
    const [row] = await selectRows<{ definition: Definition }>({
      client,
      sql: 'SELECT definition FROM playbooks',
    });

    expect(Object.keys(row.definition.nodes[1])).toEqual([
      'id',
      'title',
      'kind',
      'final',
      'inputs',
    ]);
  });

  test('an archived version is renamed the same way, beside its other fields', async () => {
    const [row] = await selectRows<{ config: Record<string, unknown> }>({
      client,
      sql: 'SELECT config FROM playbook_versions',
    });

    expect(row.config).toEqual({ definition: NEW_DEFINITION, label: 'v1' });
  });

  test('an upgrade diff names each changed node by node_id', async () => {
    const [row] = await selectRows<{ diff: unknown }>({
      client,
      sql: 'SELECT diff FROM playbook_upgrades',
    });

    expect(row.diff).toEqual({
      ...OLD_DIFF,
      changed: [{ node_id: 'pricing', executor: false, inputs: [] }],
    });
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();

    const [row] = await selectRows<{ definition: Definition }>({
      client,
      sql: 'SELECT definition FROM playbooks',
    });
    expect(row.definition).toEqual(NEW_DEFINITION);
  });
});
