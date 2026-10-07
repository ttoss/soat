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

const DATABASE = `soat_migration_decisions_openai_shape_${process.pid}`;
const NAME = '2026-10-07-decisions-openai-shape';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

const OLD_QUESTIONS = {
  route: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { technical: 'Errors', billing: 'Charges' },
  },
  severity: {
    type: 'score',
    instructions: 'How urgent?',
    criteria: ['Cosmetic', 'Blocking'],
  },
  needs_human: {
    type: 'boolean',
    instructions: 'Must a person read it?',
    criteria: { false: 'No', true: 'Yes' },
  },
};

const OLD_ANSWERS = {
  route: {
    type: 'choice',
    choice: 'billing',
    probabilities: { billing: 0.8, technical: 0.2 },
  },
  severity: {
    type: 'score',
    score: 1,
    legend: 'Blocking',
    probabilities: { '0': 0.3, '1': 0.7 },
  },
  needs_human: { type: 'boolean', value: true },
};

const NEW_QUESTIONS = [
  {
    type: 'choice',
    name: 'route',
    instructions: 'Which team?',
    choices: [
      { value: 'technical', description: 'Errors' },
      { value: 'billing', description: 'Charges' },
    ],
  },
  {
    type: 'score',
    name: 'severity',
    instructions: 'How urgent?',
    levels: [
      { label: 'Cosmetic', description: 'Cosmetic' },
      { label: 'Blocking', description: 'Blocking' },
    ],
  },
  {
    type: 'predicate',
    name: 'needs_human',
    instructions: 'Must a person read it?\n\nTrue: Yes\nFalse: No',
  },
];

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

    const questions = JSON.stringify(OLD_QUESTIONS).replace(/'/g, "''");
    const answers = JSON.stringify(OLD_ANSWERS).replace(/'/g, "''");
    await client.query(`
      CREATE TABLE deciders (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        questions json NOT NULL
      );
      CREATE TABLE decider_versions (
        id serial PRIMARY KEY,
        decider_id integer NOT NULL REFERENCES deciders (id),
        version integer NOT NULL,
        config json NOT NULL
      );
      CREATE TABLE decisions (
        id serial PRIMARY KEY,
        decider_id varchar(32) NOT NULL,
        decider_version integer NOT NULL,
        answers jsonb
      );

      INSERT INTO deciders (public_id, questions)
        VALUES ('dcd_1', '${questions}');
      INSERT INTO decider_versions (decider_id, version, config)
        VALUES (1, 1, '{"questions": ${questions}}');
      INSERT INTO decisions (decider_id, decider_version, answers)
        VALUES ('dcd_1', 1, '${answers}'), ('dcd_1', 1, NULL);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a decider holds its questions as an array, in their order', async () => {
    const rows = await selectRows<{ questions: unknown }>({
      client,
      sql: 'SELECT questions FROM deciders',
    });
    expect(rows).toEqual([{ questions: NEW_QUESTIONS }]);
  });

  test('an archived version is converted the same way', async () => {
    const rows = await selectRows<{ config: unknown }>({
      client,
      sql: 'SELECT config FROM decider_versions',
    });
    expect(rows).toEqual([{ config: { questions: NEW_QUESTIONS } }]);
  });

  test('a settled decision answers in question order', async () => {
    const rows = await selectRows<{ answers: unknown }>({
      client,
      sql: 'SELECT answers FROM decisions WHERE answers IS NOT NULL',
    });
    expect(rows).toEqual([
      {
        answers: [
          {
            type: 'choice',
            name: 'route',
            choice: 'billing',
            probabilities: expect.arrayContaining([
              { value: 'billing', probability: 0.8 },
              { value: 'technical', probability: 0.2 },
            ]),
          },
          {
            type: 'score',
            name: 'severity',
            score: 1,
            probabilities: [
              { value: 0, label: 'Cosmetic', probability: 0.3 },
              { value: 1, label: 'Blocking', probability: 0.7 },
            ],
          },
          { type: 'predicate', name: 'needs_human', probability: 1 },
        ],
      },
    ]);
  });

  test('an unsettled decision keeps null answers', async () => {
    const rows = await selectRows<{ count: string }>({
      client,
      sql: 'SELECT count(*) FROM decisions WHERE answers IS NULL',
    });
    expect(rows).toEqual([{ count: '1' }]);
  });

  test('a decision may carry its own questions and name no decider', async () => {
    expect(
      await columnType({ client, table: 'decisions', column: 'questions' })
    ).toBe('json');
    await client.query(`INSERT INTO decisions (questions) VALUES ('[]')`);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
