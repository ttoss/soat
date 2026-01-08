import { Ollama } from 'ollama';

import type { EmbeddingResult, OllamaConfig } from '../types.js';

export const generateEmbedding = async (args: {
  config: OllamaConfig;
  text: string;
}): Promise<EmbeddingResult> => {
  const { config, text } = args;
  const ollama = new Ollama({ host: config.host });

  const response = await ollama.embed({
    model: config.model,
    input: text,
  });

  return {
    embedding: response.embeddings[0],
    model: config.model,
    provider: 'ollama',
  };
};

export const generateEmbeddings = async (args: {
  config: OllamaConfig;
  texts: string[];
}): Promise<EmbeddingResult[]> => {
  const { config, texts } = args;
  const ollama = new Ollama({ host: config.host });

  const response = await ollama.embed({
    model: config.model,
    input: texts,
  });

  return response.embeddings.map((embedding) => {
    return {
      embedding,
      model: config.model,
      provider: 'ollama' as const,
    };
  });
};
