import ollama from 'ollama';
import pgvector from 'pgvector/pg';

export const embedText = async (text: string): Promise<string> => {
  const result = await ollama.embed({
    model: 'qwen3-embedding:0.6b',
    input: text,
  });

  return pgvector.toSql(result.embeddings[0]);
};
