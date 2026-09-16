import { Sequelize } from '@ttoss/postgresdb';

const ADMIN_DATABASE = 'postgres';

const connectionConfig = () => {
  return {
    username: process.env.TEST_DB_USERNAME ?? 'postgres',
    password: process.env.TEST_DB_PASSWORD ?? '',
    host: process.env.TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT ?? 5432),
  };
};

export const connectTo = (database: string): Sequelize => {
  return new Sequelize({
    dialect: 'postgres',
    logging: false,
    database,
    ...connectionConfig(),
  });
};

/**
 * A database of its own per test: the migrations read and write `public` by
 * name, so a schema per test would not isolate them.
 */
export const createDatabase = async (name: string): Promise<Sequelize> => {
  const admin = connectTo(ADMIN_DATABASE);

  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }

  const client = connectTo(name);

  await client.query('CREATE EXTENSION IF NOT EXISTS vector');

  return client;
};

export const dropDatabase = async (name: string): Promise<void> => {
  const admin = connectTo(ADMIN_DATABASE);

  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
};

/**
 * The schema as it stood before `2026-09-16`: `memories` is the container and
 * `memory_entries` the item. Only the columns and indexes the migrations touch
 * are reproduced, plus the two tables they join against.
 *
 * `tagsType` distinguishes a database that has had the `2026-09-11` tags
 * migration (`jsonb`) from one that has not (`text[]`).
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
