import { pgPool } from '../pgPool';
import { embedText } from './embedText';

export const recordMemory = async (args: { content: string }) => {
  const embedding = await embedText(args.content);

  const client = await pgPool.connect();

  try {
    await client.query(
      'INSERT INTO memories (content, embedding) VALUES ($1, $2)',
      [args.content, embedding]
    );
  } finally {
    client.release();
  }

  return {
    success: true,
    message: 'Memory recorded successfully',
  };
};
