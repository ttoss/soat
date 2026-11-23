import type { RunResult, Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import { createDatabase, dropDatabase, selectRows } from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_formation_parameter_types_${process.pid}`;
const NAME = '2026-11-23-formation-parameter-types';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const templates = async (args: { client: Sequelize }): Promise<string[]> => {
  const rows = await selectRows<{ template: string | null }>({
    client: args.client,
    sql: 'SELECT template::text AS template FROM formations ORDER BY id',
  });
  return rows.map((row) => {
    return String(row.template);
  });
};

const STORED = [
  {
    resources: {},
    parameters: {
      OwnerName: { type: 'String', description: 'Owner' },
      Limit: { default: 3, type: 'Number' },
      Tags: { type: 'LIST', default: '[]' },
      Payload: { type: 'object', default: { a: 1 } },
      Plain: { type: 'string' },
      Untyped: { default: 'x' },
    },
  },
  { resources: {}, parameters: { Ok: { type: 'number' } } },
  { resources: {} },
  null,
];

const MIGRATED = [
  {
    resources: {},
    parameters: {
      OwnerName: { type: 'string', description: 'Owner' },
      Limit: { default: 3, type: 'number' },
      Tags: { type: 'list', default: '[]' },
      Payload: { default: { a: 1 } },
      Plain: { type: 'string' },
      Untyped: { default: 'x' },
    },
  },
  { resources: {}, parameters: { Ok: { type: 'number' } } },
  { resources: {} },
  null,
];

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;
  let firstRun: RunResult;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);
    await client.query(
      'CREATE TABLE formations (id serial PRIMARY KEY, template json);'
    );
    for (const template of STORED) {
      await client.query('INSERT INTO formations (template) VALUES ($1)', {
        bind: [template === null ? null : JSON.stringify(template)],
      });
    }
    firstRun = await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('a database holding an unaccepted parameter type runs it', () => {
    expect(firstRun.applied).toEqual([NAME]);
  });

  test('every declared type is one the template validator accepts, key order kept', async () => {
    expect(await templates({ client })).toEqual(
      MIGRATED.map((template) => {
        return String(template === null ? null : JSON.stringify(template));
      })
    );
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
    await client?.close();
    await dropDatabase(EMPTY);
  });

  test('it records itself without running', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.detected).toEqual([NAME]);
  });
});
