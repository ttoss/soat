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

// Establish database connection before starting the server
const startServer = async () => {
  try {
    // Optional: Test the pool by getting and releasing a client
    const client = await pgPool.connect();
    client.release(); // Release back to pool
    // eslint-disable-next-line no-console
    console.log('Database connected successfully');

    app.listen(3000, () => {
      // eslint-disable-next-line no-console
      console.log('SOAT Server is running on http://localhost:3000');
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to connect to database:', error);
    process.exit(1); // Exit if DB connection fails
  }
};

startServer();
