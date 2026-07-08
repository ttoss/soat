import { models } from '@soat/postgresdb';
import type { App } from '@ttoss/http-server';
import { initialize } from '@ttoss/postgresdb';

export { models };

export type DB = Awaited<ReturnType<typeof initialize<typeof models>>>;

export let db: DB;

/**
 * Build the options passed to `@ttoss/postgresdb`'s `initialize`.
 *
 * `keepDefaultTimezone: true` stops Sequelize from issuing
 * `SET TIME ZONE INTERVAL '+00:00' HOUR TO MINUTE` on every new pooled
 * connection. Sequelize v6 sends that alongside `SET client_min_messages` as a
 * single multi-statement session-setup query, which crashes AWS Aurora
 * PostgreSQL 18.3 (the whole instance restarts) and prevents the server from
 * booting. Sequelize's default timezone is already UTC — the same as
 * PostgreSQL's default session timezone — so suppressing the SET has no
 * behavioural effect while keeping the server bootable on Aurora 18.3.
 */
export const buildDatabaseConfig = () => {
  return {
    models,
    createVectorExtension: true,
    keepDefaultTimezone: true,
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  };
};

/**
 * Surface a database connection failure to stderr.
 *
 * Startup exits with `process.exit(1)` and the `debug` logger is normally
 * disabled in production, so without an explicit `console.error` the connection
 * error is swallowed entirely — nothing reaches a TTY, a pipe, a file, or
 * CloudWatch. Printing here turns a silent `exit 1` into an actionable message.
 */
export const logDatabaseConnectionError = (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('failed to connect to database:', error);
};

export const initializeDatabase = async (app: App) => {
  db = await initialize(buildDatabaseConfig());

  app.context.db = db;

  return db;
};
