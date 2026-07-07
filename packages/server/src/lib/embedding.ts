import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAI } from '@ai-sdk/openai';
import { type EmbeddingModel, embedMany } from 'ai';
import createDebug from 'debug';

import { resolveBedrockCredentials } from './agentModel';

const log = createDebug('soat:embedding');

export type EmbeddingProvider = 'ollama' | 'openai' | 'bedrock';

const buildOpenAiEmbeddingModel = (args: { model: string }): EmbeddingModel => {
  const apiKey =
    process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  // EMBEDDING_BASE_URL lets any OpenAI-compatible endpoint (a gateway, a
  // self-hosted embedding server) reuse the OpenAI builder without a new branch.
  const baseURL = process.env.EMBEDDING_BASE_URL;
  return createOpenAI({ apiKey, baseURL }).textEmbeddingModel(args.model);
};

const buildOllamaEmbeddingModel = (args: { model: string }): EmbeddingModel => {
  // Ollama exposes an OpenAI-compatible `/v1/embeddings` endpoint, so it reuses
  // the OpenAI builder against the local base URL — the same approach
  // `buildOllamaModel` takes for chat models in `agentModel.ts`.
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  return createOpenAI({
    apiKey: 'ollama',
    baseURL: `${base}/v1`,
  }).textEmbeddingModel(args.model);
};

const buildBedrockEmbeddingModel = (args: {
  model: string;
}): EmbeddingModel => {
  // Reuse the same credential precedence as chat models (agentModel.ts): an
  // ABSK bearer token in EMBEDDING_API_KEY wins, otherwise the AWS default
  // credential chain (AWS_ACCESS_KEY_ID/…) is used by the provider.
  const credentials = resolveBedrockCredentials({
    secretValue: process.env.EMBEDDING_API_KEY ?? null,
    config: { region: process.env.EMBEDDING_REGION ?? process.env.AWS_REGION },
  });
  return createAmazonBedrock(credentials).textEmbeddingModel(args.model);
};

/**
 * Resolves an `EmbeddingProvider` to a unified AI SDK `EmbeddingModel`. All
 * providers — including Ollama, via its OpenAI-compatible endpoint — flow
 * through this single builder, mirroring `buildModel` in `agentModel.ts`.
 * Adding a new backend is one `case` here; `getEmbeddings` and every caller
 * stay unchanged.
 */
export const buildEmbeddingModel = (args: {
  provider: EmbeddingProvider;
  model: string;
}): EmbeddingModel => {
  switch (args.provider) {
    case 'ollama':
      return buildOllamaEmbeddingModel(args);
    case 'openai':
      return buildOpenAiEmbeddingModel(args);
    case 'bedrock':
      return buildBedrockEmbeddingModel(args);
    default:
      throw new Error(`Unsupported embedding provider: ${args.provider}`);
  }
};

const isEmbeddingProvider = (value: string): value is EmbeddingProvider => {
  return value === 'ollama' || value === 'openai' || value === 'bedrock';
};

export const getEmbeddings = async (args: {
  texts: string[];
}): Promise<number[][]> => {
  const provider = process.env.EMBEDDING_PROVIDER;
  const model = process.env.EMBEDDING_MODEL;

  if (!provider || !model) {
    throw new Error(
      'EMBEDDING_PROVIDER and EMBEDDING_MODEL environment variables must be set'
    );
  }

  if (!isEmbeddingProvider(provider)) {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }

  log(
    'getEmbeddings: provider=%s model=%s count=%d',
    provider,
    model,
    args.texts.length
  );

  const { embeddings } = await embedMany({
    model: buildEmbeddingModel({ provider, model }),
    values: args.texts,
  });

  return embeddings;
};

export const getEmbedding = async (args: {
  text: string;
}): Promise<number[]> => {
  const [embedding] = await getEmbeddings({ texts: [args.text] });
  return embedding;
};
