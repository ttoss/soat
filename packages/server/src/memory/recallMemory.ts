import { pgPool } from '../pgPool';
import { embedText } from './embedText';

export const recallMemory = async (args: { query: string; limit?: number }) => {
  const limit = args.limit ?? 10;

  const queryEmbedding = await embedText(args.query);

  const client = await pgPool.connect();

  try {
    const result = await client.query(
      `SELECT content, embedding <-> $1 AS distance
       FROM memories
       ORDER BY distance
       LIMIT $2`,
      [queryEmbedding, limit]
    );

    return {
      success: true,
      memories: result.rows.map((row) => {
        return {
          content: row.content,
          distance: row.distance,
        };
      }),
    };
  } finally {
    client.release();
  }
};
