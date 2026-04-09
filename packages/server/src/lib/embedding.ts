import { Ollama } from 'ollama';

export const getEmbedding = async (args: {
  text: string;
}): Promise<number[]> => {
  const provider = process.env.EMBEDDING_PROVIDER;
  const model = process.env.EMBEDDING_MODEL;

  if (!provider || !model) {
    throw new Error(
      'EMBEDDING_PROVIDER and EMBEDDING_MODEL environment variables must be set'
    );
  }

  if (provider === 'ollama') {
    const host = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const ollama = new Ollama({ host });
    const response = await ollama.embed({ model, input: args.text });
    return response.embeddings[0];
  }

  throw new Error(`Unsupported embedding provider: ${provider}`);
};
