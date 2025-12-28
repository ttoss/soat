import { App, bodyParser, cors } from '@ttoss/http-server';

import { apiRouter } from './apiRouter';
import { mcpRouter } from './mcpRouter';
import { pgPool } from './pgPool';

const app = new App();

app.use(cors());
app.use(bodyParser());

app.use(mcpRouter.routes());
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

/**
 * S: 5
 * O: 0
 * A: 4
 * T: 7
 */
const SOAT_PORT = 5047;

// Establish database connection before starting the server
const startServer = async () => {
  try {
    // Optional: Test the pool by getting and releasing a client
    const client = await pgPool.connect();
    client.release(); // Release back to pool
    // eslint-disable-next-line no-console
    console.log('Database connected successfully');

    app.listen(SOAT_PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`SOAT Server is running on http://localhost:${SOAT_PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to connect to database:', error);
    process.exit(1); // Exit if DB connection fails
  }
};

startServer();
