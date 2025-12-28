import { Pool } from 'pg';
import pgvector from 'pgvector/pg';

const pgPool = new Pool({
  database: 'postgres',
  user: 'postgres',
  password: 'yourpassword',
  host: 'localhost',
  port: 5432,
});

pgPool.on('connect', async (client) => {
  await pgvector.registerTypes(client);
});

export { pgPool };
