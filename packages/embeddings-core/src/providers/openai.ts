import type { EmbeddingResult, OpenAIConfig } from '../types.js';

const DEFAULT_MODEL = 'text-embedding-3-small';

export const generateEmbedding = async (args: {
  config: OpenAIConfig;
  text: string;
}): Promise<EmbeddingResult> => {
  const { config, text } = args;
  const model = config.model || DEFAULT_MODEL;

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();

  return {
    embedding: data.data[0].embedding,
    model,
    provider: 'openai',
  };
};

export const generateEmbeddings = async (args: {
  config: OpenAIConfig;
  texts: string[];
}): Promise<EmbeddingResult[]> => {
  const { config, texts } = args;
  const model = config.model || DEFAULT_MODEL;

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();

  return data.data.map((item: { embedding: number[] }) => {
    return {
      embedding: item.embedding,
      model,
      provider: 'openai' as const,
    };
  });
};
