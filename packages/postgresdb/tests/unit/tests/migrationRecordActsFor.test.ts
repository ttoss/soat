import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  columnType,
  createDatabase,
  dropDatabase,
  selectRows,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_record_acts_for_${process.pid}`;
const NAME = '2026-11-26-record-acts-for';

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

afterAll(async () => {
  await dropDatabase(DATABASE);
});

describe(NAME, () => {
  let client: Sequelize;

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    // Only two of the tables: a deployment without the rest still migrates.
    await client.query(`
      CREATE TABLE audit_entries (id serial PRIMARY KEY);
      CREATE TABLE exception_items (id serial PRIMARY KEY);
      INSERT INTO audit_entries DEFAULT VALUES;
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client?.close();
  });

  test.each([
    ['audit_entries', 'acts_for_type'],
    ['audit_entries', 'acts_for_id'],
    ['exception_items', 'acknowledged_by_acts_for_type'],
    ['exception_items', 'acknowledged_by_acts_for_id'],
    ['exception_items', 'resolved_by_acts_for_type'],
    ['exception_items', 'resolved_by_acts_for_id'],
  ])('adds %s.%s', async (table, column) => {
    expect(await columnType({ client, table, column })).toBe(
      'character varying'
    );
  });

  test('existing rows act for no one', async () => {
    expect(
      await selectRows<{ acts_for_type: unknown; acts_for_id: unknown }>({
        client,
        sql: 'SELECT acts_for_type, acts_for_id FROM audit_entries WHERE id = 1',
      })
    ).toEqual([{ acts_for_type: null, acts_for_id: null }]);
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
