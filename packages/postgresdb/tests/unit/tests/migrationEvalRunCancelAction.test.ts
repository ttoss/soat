import type { RunResult, Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import { createDatabase, dropDatabase, selectRows } from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_eval_run_cancel_action_${process.pid}`;
const NAME = '2026-11-18-eval-run-cancel-action';

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

const document = (...statements: Array<[string, string[]]>) => {
  return {
    statement: statements.map(([effect, action]) => {
      return { effect, action, resource: ['*'] };
    }),
  };
};

const RUN = 'evaluations:RunEval';
const CANCEL = 'evaluations:CancelEvalRun';

const BEFORE = [
  document(['Allow', ['evaluations:GetEval', RUN]]),
  document(['Allow', [RUN]], ['Deny', [RUN]]),
  document(['Allow', [RUN, CANCEL]]),
  document(['Allow', ['evaluations:*']]),
  document(['Allow', ['agents:CreateAgentGeneration']]),
];

const AFTER = [
  document(['Allow', ['evaluations:GetEval', RUN, CANCEL]]),
  document(['Allow', [RUN, CANCEL]], ['Deny', [RUN, CANCEL]]),
  document(['Allow', [RUN, CANCEL]]),
  document(['Allow', ['evaluations:*']]),
  document(['Allow', ['agents:CreateAgentGeneration']]),
];

const template = (doc: object) => {
  return {
    resources: { p: { type: 'policy', properties: { document: doc } } },
  };
};

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;
  let firstRun: RunResult;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    const literal = (value: object) => {
      return `'${JSON.stringify(value)}'`;
    };
    const rows = (values: object[]) => {
      return values
        .map((value) => {
          return `(${literal(value)})`;
        })
        .join(', ');
    };
    await client.query(`
      CREATE TABLE policies (id serial PRIMARY KEY, document json NOT NULL);
      INSERT INTO policies (document) VALUES ${rows(BEFORE)};

      CREATE TABLE formations (id serial PRIMARY KEY, template json);
      INSERT INTO formations (template) VALUES ${rows([template(BEFORE[0])])}, (NULL);

      CREATE TABLE formation_resources (
        id serial PRIMARY KEY, last_applied_properties json);
      INSERT INTO formation_resources (last_applied_properties) VALUES
        ${rows([{ document: BEFORE[1] }])};
    `);

    firstRun = await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test('a database holding a RunEval grant runs it rather than detecting it', () => {
    expect(firstRun.applied).toEqual([NAME]);
  });

  test('every statement naming RunEval also names CancelEvalRun', async () => {
    expect(
      await column({ client, table: 'policies', column: 'document' })
    ).toEqual(AFTER);
  });

  test('a rewritten document keeps its key order', async () => {
    const [text] = await column({
      client,
      table: 'policies',
      column: 'document::text',
    });
    const [first] = (JSON.parse(String(text)) as (typeof AFTER)[0]).statement;
    expect(Object.keys(first)).toEqual(['effect', 'action', 'resource']);
  });

  test('a stored template and what it last applied gain it too', async () => {
    expect(
      await column({ client, table: 'formations', column: 'template' })
    ).toEqual([template(AFTER[0]), null]);
    expect(
      await column({
        client,
        table: 'formation_resources',
        column: 'last_applied_properties',
      })
    ).toEqual([{ document: AFTER[1] }]);
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
    await client?.close();
    await dropDatabase(EMPTY);
  });

  test('it records itself without running', async () => {
    const result = await runnerFor({ client }).run({ names: [NAME] });
    expect(result.detected).toEqual([NAME]);
  });
});
