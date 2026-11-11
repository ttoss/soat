import type { RunResult, Sequelize } from '@ttoss/postgresdb';
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

const DATABASE = `soat_migration_iam_condition_keys_${process.pid}`;
const NAME = '2026-11-11-iam-condition-keys';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const column = async (args: {
  client: Sequelize;
  table: string;
  column: string;
}): Promise<unknown[]> => {
  const rows = await selectRows<{ value: unknown }>({
    client: args.client,
    sql: `SELECT ${args.column} AS value FROM ${args.table} ORDER BY id`,
  });
  return rows.map((row) => {
    return row.value;
  });
};

const statement = (condition: object) => {
  return {
    statement: [
      { effect: 'Allow', action: ['files:*'], resource: ['*'], condition },
    ],
  };
};

const SOAT_CONDITION = {
  StringEquals: {
    'soat:ResourceType': 'file',
    'soat:ResourceTag/owner': '${soat:ActorId}',
  },
};

const IAM_CONDITION = {
  StringEquals: {
    'iam:ResourceType': 'file',
    'iam:ResourceTag/owner': '${iam:ActorId}',
  },
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
  let firstRun: RunResult;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    // The tables as they stand before the change, reduced to the columns it
    // reads and writes.
    const literal = (value: object) => {
      return `'${JSON.stringify(value)}'`;
    };
    await client.query(`
      CREATE TABLE policies (id serial PRIMARY KEY, document jsonb NOT NULL);
      INSERT INTO policies (document) VALUES
        (${literal(statement(SOAT_CONDITION))}),
        (${literal({ statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }] })});

      CREATE TABLE formations (id serial PRIMARY KEY, template jsonb);
      INSERT INTO formations (template) VALUES
        (${literal({ resources: { p: { type: 'policy', properties: { document: statement(SOAT_CONDITION) } } } })});

      CREATE TABLE formation_resources (
        id serial PRIMARY KEY, last_applied_properties jsonb);
      INSERT INTO formation_resources (last_applied_properties) VALUES
        (${literal({ document: statement(SOAT_CONDITION) })});
    `);

    firstRun = await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a database holding the old keys runs it rather than detecting it', () => {
    expect(firstRun.applied).toEqual([NAME]);
  });

  test('a stored policy names the iam keys and variable', async () => {
    expect(
      await column({ client, table: 'policies', column: 'document' })
    ).toEqual([
      statement(IAM_CONDITION),
      { statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }] },
    ]);
  });

  test('a stored template and what it last applied name the iam keys', async () => {
    expect(
      await column({ client, table: 'formations', column: 'template' })
    ).toEqual([
      {
        resources: {
          p: {
            type: 'policy',
            properties: { document: statement(IAM_CONDITION) },
          },
        },
      },
    ]);
    expect(
      await column({
        client,
        table: 'formation_resources',
        column: 'last_applied_properties',
      })
    ).toEqual([{ document: statement(IAM_CONDITION) }]);
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
