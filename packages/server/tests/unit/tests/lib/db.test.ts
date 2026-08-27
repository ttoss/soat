import {
  buildDatabaseConfig,
  getSchemaSyncLockTimeoutMs,
  isConcurrentExtensionCreationError,
  logDatabaseConnectionError,
  SCHEMA_SYNC_LOCK_KEY,
  syncSchemaWithAdvisoryLock,
} from 'src/db';

import { sequelize } from '../../setupTestsAfterEnv';

describe('buildDatabaseConfig', () => {
  const savedEnv = {
    host: process.env.DATABASE_HOST,
    port: process.env.DATABASE_PORT,
    name: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  };

  afterEach(() => {
    process.env.DATABASE_HOST = savedEnv.host;
    process.env.DATABASE_PORT = savedEnv.port;
    process.env.DATABASE_NAME = savedEnv.name;
    process.env.DATABASE_USER = savedEnv.user;
    process.env.DATABASE_PASSWORD = savedEnv.password;
  });

  test('enables keepDefaultTimezone so Sequelize skips the SET TIME ZONE that crashes Aurora PostgreSQL 18.3', () => {
    // Regression guard: without keepDefaultTimezone, Sequelize v6 sends
    // `SET client_min_messages ...;SET TIME ZONE INTERVAL '+00:00' ...` as one
    // multi-statement query on every pooled connection, which crashes Aurora
    // 18.3 and blocks boot. Removing this flag would re-break Aurora boot.
    expect(buildDatabaseConfig().keepDefaultTimezone).toBe(true);
  });

  test('always creates the vector extension', () => {
    expect(buildDatabaseConfig().createVectorExtension).toBe(true);
  });

  test('maps DATABASE_* env vars to the connection config', () => {
    process.env.DATABASE_HOST = 'db.example.com';
    process.env.DATABASE_PORT = '6543';
    process.env.DATABASE_NAME = 'soat';
    process.env.DATABASE_USER = 'soat_user';
    process.env.DATABASE_PASSWORD = 'secret';

    const config = buildDatabaseConfig();

    expect(config.host).toBe('db.example.com');
    expect(config.port).toBe(6543);
    expect(config.database).toBe('soat');
    expect(config.username).toBe('soat_user');
    expect(config.password).toBe('secret');
  });
});

describe('getSchemaSyncLockTimeoutMs', () => {
  const savedTimeout = process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS;

  afterEach(() => {
    if (savedTimeout === undefined) {
      delete process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS;
    } else {
      process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS = savedTimeout;
    }
  });

  test('defaults to 600000ms (10min) when the env var is unset', () => {
    // The default must exceed a real migration's duration so a task merely
    // waiting for a live peer's sync waits it out instead of aborting.
    delete process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS;
    expect(getSchemaSyncLockTimeoutMs()).toBe(600_000);
  });

  test('honours a valid positive-integer override from the env var', () => {
    process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS = '30000';
    expect(getSchemaSyncLockTimeoutMs()).toBe(30_000);
  });

  test.each([
    ['not-a-number', 'not-a-number'],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1500.5'],
    ['empty string', ''],
  ])(
    'falls back to the default for an invalid override (%s)',
    (_label, value) => {
      // A misconfigured bound must never become an unbounded (0) or nonsensical
      // wait — any non-positive-integer value falls back to the safe default.
      process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS = value;
      expect(getSchemaSyncLockTimeoutMs()).toBe(600_000);
    }
  );
});

describe('schema sync reboot idempotency', () => {
  test('sync({ alter: true }) does not crash when run again against an already-synced schema', async () => {
    // A derived name over Postgres's 63-char limit is truncated on create, so
    // the next `sync({ alter: true })` recomputes the full name, sees it
    // missing, and recreates it — 42P07 on every boot after the first.
    await expect(sequelize.sync({ alter: true })).resolves.not.toThrow();
  });
});

describe('syncSchemaWithAdvisoryLock', () => {
  test('serializes concurrent boot syncs on SOAT’s advisory lock key', async () => {
    // Without the lock, two boots race their ALTER TABLE steps on one DB. Holds
    // the boot-sync lock on one connection, then asserts a sync does not proceed
    // until it is released.
    let synced = false;

    await sequelize.transaction(async (t) => {
      // Acquire the lock on this transaction's dedicated connection.
      await sequelize.query('SELECT pg_advisory_lock(:key)', {
        replacements: { key: SCHEMA_SYNC_LOCK_KEY },
        transaction: t,
      });

      const syncPromise = syncSchemaWithAdvisoryLock({ sequelize }).then(() => {
        synced = true;
      });

      // `synced` is monotonic and only flips after the unlock below, so this
      // cannot false-fail on a slow machine — a helper that skipped the wait
      // would have flipped it here.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(synced).toBe(false);

      // Release the lock; the waiting sync now acquires it and completes.
      await sequelize.query('SELECT pg_advisory_unlock(:key)', {
        replacements: { key: SCHEMA_SYNC_LOCK_KEY },
        transaction: t,
      });
      await syncPromise;
      expect(synced).toBe(true);
    });
  });

  test('fails fast with a lock-timeout error when the lock is held past the bound', async () => {
    // A peer SIGKILLed mid-boot holds the advisory lock until its backend is
    // reaped, which can be minutes behind a pooler — unbounded, every later boot
    // blocks forever and the deploy deadlocks (#549).
    const saved = process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS;
    process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS = '250';

    try {
      await sequelize.transaction(async (t) => {
        await sequelize.query('SELECT pg_advisory_lock(:key)', {
          replacements: { key: SCHEMA_SYNC_LOCK_KEY },
          transaction: t,
        });

        const startedAt = Date.now();
        await expect(syncSchemaWithAdvisoryLock({ sequelize })).rejects.toThrow(
          /lock timeout/i
        );
        // The bound is what ends the wait — the call must return in well under
        // the multi-minute backend-reap window, proving it did not block on the
        // held lock indefinitely.
        expect(Date.now() - startedAt).toBeLessThan(10_000);

        await sequelize.query('SELECT pg_advisory_unlock(:key)', {
          replacements: { key: SCHEMA_SYNC_LOCK_KEY },
          transaction: t,
        });
      });
    } finally {
      if (saved === undefined) {
        delete process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS;
      } else {
        process.env.SCHEMA_SYNC_LOCK_TIMEOUT_MS = saved;
      }
    }
  });
});

describe('logDatabaseConnectionError', () => {
  test('writes the connection error to stderr so it is not swallowed on startup exit', () => {
    // `console.error` is mocked to a no-op in setupTestsAfterEnv's beforeEach.
    // eslint-disable-next-line no-console
    const errorSpy = jest.mocked(console.error);
    const error = new Error('Connection terminated unexpectedly');

    logDatabaseConnectionError(error);

    expect(errorSpy).toHaveBeenCalledWith(
      'failed to connect to database:',
      error
    );
  });
});

// `CREATE EXTENSION IF NOT EXISTS` is not race-safe: two processes booting
// together can both pass the existence check and one loses on
// `pg_extension_name_index`. This predicate tells that race from a real failure.
describe('isConcurrentExtensionCreationError', () => {
  const raceError = (code: string): unknown => {
    return Object.assign(new Error('duplicate key value'), {
      sql: 'CREATE EXTENSION IF NOT EXISTS vector;',
      original: Object.assign(new Error('duplicate key value'), { code }),
    });
  };

  test('recognizes the unique-violation form (23505)', () => {
    expect(isConcurrentExtensionCreationError(raceError('23505'))).toBe(true);
  });

  test('recognizes the duplicate-object form (42710)', () => {
    expect(isConcurrentExtensionCreationError(raceError('42710'))).toBe(true);
  });

  test('reads the code off `parent` as well as `original`', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      sql: 'CREATE EXTENSION IF NOT EXISTS vector;',
      parent: Object.assign(new Error('duplicate key value'), {
        code: '23505',
      }),
    });
    expect(isConcurrentExtensionCreationError(error)).toBe(true);
  });

  test.each([
    ['a different statement', 'INSERT INTO users (id) VALUES (1);', '23505'],
    [
      'an unrelated error code',
      'CREATE EXTENSION IF NOT EXISTS vector;',
      '42501',
    ],
  ])('rejects %s', (_label, sql, code) => {
    const error = Object.assign(new Error('nope'), {
      sql,
      original: Object.assign(new Error('nope'), { code }),
    });
    expect(isConcurrentExtensionCreationError(error)).toBe(false);
  });

  test.each([
    ['a connection refusal', new Error('ECONNREFUSED')],
    ['a non-error value', 'boom'],
    ['null', null],
  ])('rejects %s', (_label, error) => {
    expect(isConcurrentExtensionCreationError(error)).toBe(false);
  });
});
