import { models } from '@soat/postgresdb';
import type { App } from '@ttoss/http-server';
import { initialize } from '@ttoss/postgresdb';

export { models };

export type DB = Awaited<ReturnType<typeof initialize<typeof models>>>;

export let db: DB;

export const initializeDatabase = async (app: App) => {
  db = await initialize({
    models,
    createVectorExtension: true,
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  });

  app.context.db = db;

  return db;
};
