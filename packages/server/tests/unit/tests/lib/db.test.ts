import { buildDatabaseConfig, logDatabaseConnectionError } from 'src/db';

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

describe('schema sync reboot idempotency', () => {
  test('sync({ alter: true }) does not crash when run again against an already-synced schema', async () => {
    // Regression guard: an auto-generated index/constraint name longer than
    // Postgres's 63-char identifier limit gets silently truncated on create.
    // The next `sync({ alter: true })` recomputes the full (untruncated) name,
    // sees it "missing" against the truncated one actually in the catalog, and
    // tries to recreate it -> 42P07 "relation already exists". This crashes
    // every boot after the first against a persisted database.
    await expect(sequelize.sync({ alter: true })).resolves.not.toThrow();
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
