import 'dotenv/config';

import { app } from './app';
import { initializeDatabase } from './db';

/**
 * SOAT = 5047
 */
const SOAT_PORT = process.env.PORT || 5047;

const startServer = async () => {
  try {
    const database = await initializeDatabase(app);
    await database.sequelize.sync({ alter: true }); // Sync models with the database
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
