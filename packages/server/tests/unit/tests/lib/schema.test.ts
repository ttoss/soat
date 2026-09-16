import { MIGRATIONS } from '@soat/postgresdb';
import {
  assertSchemaPrepared,
  isBootSchemaSyncEnabled,
  pendingMigrationNames,
} from 'src/schema';

import { sequelize } from '../../setupTestsAfterEnv';

const ALL_NAMES = MIGRATIONS.map((migration) => {
  return migration.name;
});

const dropLedger = async () => {
  await sequelize.query('DROP TABLE IF EXISTS schema_migrations');
};

const recordEvery = async () => {
  await sequelize.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations ("name" VARCHAR(255) PRIMARY KEY)'
  );

  for (const name of ALL_NAMES) {
    await sequelize.query(
      'INSERT INTO schema_migrations ("name") VALUES (:name) ON CONFLICT DO NOTHING',
      { replacements: { name } }
    );
  }
};

afterEach(async () => {
  await dropLedger();
});

describe('isBootSchemaSyncEnabled', () => {
  const saved = process.env.DB_SYNC;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.DB_SYNC;
    } else {
      process.env.DB_SYNC = saved;
    }
  });

  test('is off when DB_SYNC is unset, so an ordinary boot binds its port at once', () => {
    // The whole point of #548: schema DDL is a pre-deploy step, not something
    // every task blocks `app.listen` on.
    delete process.env.DB_SYNC;
    expect(isBootSchemaSyncEnabled()).toBe(false);
  });

  test('is on only for the exact string "true"', () => {
    process.env.DB_SYNC = 'true';
    expect(isBootSchemaSyncEnabled()).toBe(true);
  });

  test.each([['1'], ['yes'], ['TRUE'], [''], ['false']])(
    'stays off for %p',
    (value) => {
      // A gate that opened on any truthy-looking string would put the slow boot
      // back on a deployment that meant to turn it off.
      process.env.DB_SYNC = value;
      expect(isBootSchemaSyncEnabled()).toBe(false);
    }
  );
});

describe('pendingMigrationNames', () => {
  test('reports every migration when the ledger table does not exist', async () => {
    // A database nobody has migrated yet, including a brand-new one: boot must
    // not read "no ledger" as "nothing to do".
    await dropLedger();

    expect(await pendingMigrationNames({ sequelize })).toEqual(ALL_NAMES);
  });

  test('reports none once every migration is recorded', async () => {
    await recordEvery();

    expect(await pendingMigrationNames({ sequelize })).toEqual([]);
  });

  test('reports only what the ledger is missing', async () => {
    await recordEvery();
    await sequelize.query(
      'DELETE FROM schema_migrations WHERE "name" = :name',
      { replacements: { name: ALL_NAMES[ALL_NAMES.length - 1] } }
    );

    expect(await pendingMigrationNames({ sequelize })).toEqual([
      ALL_NAMES[ALL_NAMES.length - 1],
    ]);
  });

  test('creates nothing, so concurrent boots cannot race each other', async () => {
    await dropLedger();
    await pendingMigrationNames({ sequelize });

    const [rows] = await sequelize.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`
    );

    expect((rows as { present: boolean }[])[0].present).toBe(false);
  });
});

describe('assertSchemaPrepared', () => {
  test('resolves when the ledger holds every migration', async () => {
    await recordEvery();

    await expect(assertSchemaPrepared({ sequelize })).resolves.toBeUndefined();
  });

  test('refuses a database the migrate step has not run against', async () => {
    await dropLedger();

    await expect(assertSchemaPrepared({ sequelize })).rejects.toThrow(
      /migrate\.mjs run/
    );
  });

  test('names the migrations that are missing', async () => {
    await dropLedger();

    await expect(assertSchemaPrepared({ sequelize })).rejects.toThrow(
      new RegExp(ALL_NAMES[0])
    );
  });
});
