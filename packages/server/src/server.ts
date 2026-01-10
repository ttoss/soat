/* eslint-disable turbo/no-undeclared-env-vars */
import 'dotenv/config';

import { models } from '@soat/postgresdb';
import { initialize } from '@ttoss/postgresdb';

import { app } from './app';

/**
 * SOAT = 5047
 */
const SOAT_PORT = process.env.PORT || 5047;

const startServer = async () => {
  try {
    await initialize({
      models,
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      database: process.env.DATABASE_NAME,
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to connect to database:', error);
    process.exit(1); // Exit if DB connection fails
  }

  app.listen(SOAT_PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`SOAT Server is running on http://localhost:${SOAT_PORT}`);
  });
};

startServer();
