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

const NAME = '2026-10-17-failure-reasons-stored-error';
const DATABASE = `soat_migration_failure_reasons_${process.pid}`;

const runnerFor = (client: Sequelize) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: client,
    log: () => {
      return undefined;
    },
  });
};

type Row = { id: number; error: unknown };

describe(NAME, () => {
  let client: Sequelize;

  const errorsOf = async (table: string) => {
    const rows = await selectRows<Row>({
      client,
      sql: `SELECT id, error FROM ${table} ORDER BY id`,
    });
    return rows.map((row) => {
      return row.error;
    });
  };

  beforeAll(async () => {
    await startDatabaseServer();
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TABLE documents (
        id serial PRIMARY KEY,
        failure_reason varchar(255)
      );
      INSERT INTO documents (failure_reason) VALUES
        (NULL),
        ('INGESTION_TIMEOUT'),
        ('CONVERTER_FAILED'),
        ('extractor exploded');

      CREATE TABLE eval_results (id serial PRIMARY KEY, error text);
      INSERT INTO eval_results (error) VALUES
        (NULL),
        ('Generation did not complete (status ''requires_action''); the item could not be evaluated.'),
        ('Scoring failed: The judge did not answer with a JSON object: nope'),
        ('provider exploded');

      CREATE TABLE formation_operations (
        id serial PRIMARY KEY,
        events jsonb,
        error jsonb
      );
      INSERT INTO formation_operations (events, error) VALUES
        (NULL, NULL),
        ('[{"logicalId":"a","action":"create","status":"succeeded"},{"logicalId":"b","action":"delete","status":"failed","error":"Agent is in use"},{"logicalId":"c","action":"rollback","status":"failed","error":"Internal Server Error"},{"logicalId":"d","action":"create","status":"failed","error":"Secret missing"},{"logicalId":"e","action":"replace-cleanup","status":"failed","error":"Tool is shared"}]',
         '{"code":"SECRET_NOT_FOUND","message":"Secret missing","meta":{"logical_id":"d"}}');

      CREATE TABLE generations (id serial PRIMARY KEY, error jsonb);
      INSERT INTO generations (error) VALUES
        (NULL),
        ('{"code":"AI_PROVIDER_ERROR","message":"402"}'),
        ('{"message":"socket hang up","name":"TypeError"}');

      CREATE TABLE traces (id serial PRIMARY KEY, error jsonb);
      INSERT INTO traces (error) VALUES ('{"message":"socket hang up"}');
    `);

    await runnerFor(client).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
    await dropDatabase(DATABASE);
    await stopDatabaseServer();
  });

  test('a document carries the object in error, and failure_reason is gone', async () => {
    expect(
      await columnType({ client, table: 'documents', column: 'error' })
    ).toBe('jsonb');
    expect(
      await columnType({ client, table: 'documents', column: 'failure_reason' })
    ).toBeUndefined();
    expect(await errorsOf('documents')).toEqual([
      null,
      {
        code: 'INGESTION_TIMEOUT',
        message: 'The ingestion made no progress within the stall window.',
      },
      {
        code: 'CONVERTER_FAILED',
        message: 'The ingestion failed with CONVERTER_FAILED.',
      },
      { code: 'INGESTION_FAILED', message: 'extractor exploded' },
    ]);
  });

  test('an eval result keeps its words under the code its writer records', async () => {
    expect(
      await columnType({ client, table: 'eval_results', column: 'error' })
    ).toBe('jsonb');
    expect(await errorsOf('eval_results')).toEqual([
      null,
      expect.objectContaining({ code: 'GENERATION_NOT_COMPLETED' }),
      expect.objectContaining({ code: 'EVAL_SCORING_FAILED' }),
      { code: 'GENERATION_FAILED', message: 'provider exploded' },
    ]);
  });

  test('a failed formation event carries the object', async () => {
    const [, operation] = await selectRows<{ events: unknown }>({
      client,
      sql: 'SELECT events FROM formation_operations ORDER BY id',
    });

    expect(
      (operation.events as Array<{ logicalId: string; error?: unknown }>).map(
        (event) => {
          return [event.logicalId, event.error];
        }
      )
    ).toEqual([
      ['a', undefined],
      ['b', { code: 'FORMATION_DELETE_FAILED', message: 'Agent is in use' }],
      ['c', { code: 'INTERNAL_ERROR', message: 'Internal Server Error' }],
      ['d', { code: 'SECRET_NOT_FOUND', message: 'Secret missing' }],
      [
        'e',
        {
          code: 'FORMATION_REPLACE_CLEANUP_FAILED',
          message: 'Tool is shared',
        },
      ],
    ]);
  });

  test('a generation or trace error with no code gains GENERATION_FAILED', async () => {
    expect(await errorsOf('generations')).toEqual([
      null,
      { code: 'AI_PROVIDER_ERROR', message: '402' },
      { code: 'GENERATION_FAILED', message: 'socket hang up' },
    ]);
    expect(await errorsOf('traces')).toEqual([
      { code: 'GENERATION_FAILED', message: 'socket hang up' },
    ]);
  });

  test('re-running it is a no-op', async () => {
    const result = await runnerFor(client).run({ names: [NAME] });

    expect(result.applied).toEqual([]);
  });
});
