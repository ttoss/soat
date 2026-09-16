import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Sequelize } from '@ttoss/postgresdb';

const ADMIN_DATABASE = 'postgres';

type DatabaseConnection = {
  username: string;
  password: string;
  host: string;
  port: number;
};

let connection: DatabaseConnection | undefined;
let container: StartedPostgreSqlContainer | undefined;

/**
 * Same escape hatch the rest of the package uses: point at an already-running
 * Postgres with `TEST_DB_HOST`, otherwise start a container. Without the
 * container branch this suite passes locally and fails in CI, which sets no
 * `TEST_DB_HOST` and has nothing on 127.0.0.1:5432.
 */
export const startDatabaseServer = async (): Promise<void> => {
  if (connection) {
    return;
  }

  if (process.env.TEST_DB_HOST) {
    connection = {
      username: process.env.TEST_DB_USERNAME ?? 'postgres',
      password: process.env.TEST_DB_PASSWORD ?? '',
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT ?? 5432),
    };

    return;
  }

  container = await new PostgreSqlContainer(
    'pgvector/pgvector:0.8.2-pg18-trixie'
  ).start();

  connection = {
    username: container.getUsername(),
    password: container.getPassword(),
    host: container.getHost(),
    port: container.getPort(),
  };
};

export const stopDatabaseServer = async (): Promise<void> => {
  await container?.stop();

  container = undefined;
  connection = undefined;
};

export const databaseConnection = (): DatabaseConnection => {
  if (!connection) {
    throw new Error('startDatabaseServer() must run before the first test.');
  }

  return connection;
};

export const connectTo = (database: string): Sequelize => {
  return new Sequelize({
    dialect: 'postgres',
    logging: false,
    database,
    ...databaseConnection(),
  });
};

const withAdmin = async (fn: (admin: Sequelize) => Promise<void>) => {
  const admin = connectTo(ADMIN_DATABASE);

  try {
    await fn(admin);
  } finally {
    await admin.close();
  }
};

/**
 * A database of its own per test: the migrations read and write `public` by
 * name, so a schema per test would not isolate them.
 */
export const createEmptyDatabase = async (name: string): Promise<void> => {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });

  const client = connectTo(name);

  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await client.close();
  }
};

export const createDatabase = async (name: string): Promise<Sequelize> => {
  await createEmptyDatabase(name);

  return connectTo(name);
};

export const dropDatabase = async (name: string): Promise<void> => {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
};

/**
 * The schema as it stood before `2026-09-16-memories-rename-and-provenance`:
 * `memories` is the container and `memory_entries` the item. Only the columns
 * and indexes the migrations touch are reproduced, plus the tables they join
 * against.
 *
 * `tagsType` distinguishes a database that has had
 * `2026-09-11-memory-tags-to-jsonb` (`jsonb`) from one that has not
 * (`text[]`).
 */
export const createLegacySchema = async (args: {
  client: Sequelize;
  tagsType: 'text[]' | 'jsonb';
}): Promise<void> => {
  const { client, tagsType } = args;

  await client.query(`
    CREATE TABLE projects (
      id serial PRIMARY KEY,
      public_id varchar(32) NOT NULL
    );

    CREATE TABLE conversations (
      id serial PRIMARY KEY,
      public_id varchar(32) NOT NULL
    );

    CREATE TABLE generations (
      id serial PRIMARY KEY,
      public_id varchar(32) NOT NULL
    );

    CREATE TABLE memories (
      id serial PRIMARY KEY,
      public_id varchar(32) NOT NULL,
      project_id integer NOT NULL REFERENCES projects (id),
      name varchar(255) NOT NULL,
      description text,
      tags ${tagsType},
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX memories_public_id_unique ON memories (public_id);

    CREATE TABLE memory_entries (
      id serial PRIMARY KEY,
      public_id varchar(32) NOT NULL,
      memory_id integer NOT NULL REFERENCES memories (id),
      content text NOT NULL,
      source_type varchar(255) NOT NULL DEFAULT 'manual',
      source_conversation_id integer REFERENCES conversations (id),
      source_generation_id integer REFERENCES generations (id),
      tags ${tagsType},
      metadata jsonb,
      embedding vector(1024),
      invalidated_at timestamptz,
      superseded_by_entry_id integer REFERENCES memory_entries (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX memory_entries_public_id_unique
      ON memory_entries (public_id);

    CREATE INDEX memory_entries_embedding_hnsw_idx
      ON memory_entries USING hnsw (embedding vector_cosine_ops);
  `);
};

export const columnType = async (args: {
  client: Sequelize;
  table: string;
  column: string;
}): Promise<string | undefined> => {
  const [rows] = await args.client.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = :table
        AND column_name = :column`,
    { replacements: { table: args.table, column: args.column } }
  );

  return (rows as { data_type: string }[])[0]?.data_type;
};

export const tableExists = async (args: {
  client: Sequelize;
  table: string;
}): Promise<boolean> => {
  const [rows] = await args.client.query(
    'SELECT to_regclass(:name) IS NOT NULL AS present',
    { replacements: { name: `public."${args.table}"` } }
  );

  return Boolean((rows as { present: boolean }[])[0]?.present);
};

export const indexNames = async (args: {
  client: Sequelize;
  table: string;
}): Promise<string[]> => {
  const [rows] = await args.client.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = :table
      ORDER BY indexname`,
    { replacements: { table: args.table } }
  );

  return (rows as { indexname: string }[]).map((row) => {
    return row.indexname;
  });
};

export const selectRows = async <T>(args: {
  client: Sequelize;
  sql: string;
}): Promise<T[]> => {
  const [rows] = await args.client.query(args.sql);

  return rows as T[];
};
