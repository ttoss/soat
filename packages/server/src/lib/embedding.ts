import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAI } from '@ai-sdk/openai';
import { type EmbeddingModel, embedMany } from 'ai';
import createDebug from 'debug';

import { resolveBedrockCredentials } from './agentModel';
import { recordEmbeddingUsage } from './usageEmbeddingRecording';

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
  // The same credential precedence as chat models (agentModel.ts): bearer
  // token, then a static key pair, then the AWS default credential chain.
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

/**
 * The project an embedding call is billed to. `null` where the call belongs to
 * no single project — an unscoped `POST /embeddings`, or a knowledge search
 * whose scope spans several projects — in which case nothing is metered because
 * a usage event has no project to attribute (#1208).
 *
 * Required rather than optional at every call site, so a new caller has to say
 * which it is instead of defaulting into unmetered spend.
 */
export type EmbeddingBillingProjectId = number | null;

export const getEmbeddings = async (args: {
  texts: string[];
  projectId: EmbeddingBillingProjectId;
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
    'getEmbeddings: provider=%s model=%s count=%d projectId=%s',
    provider,
    model,
    args.texts.length,
    args.projectId
  );

  const { embeddings, usage } = await embedMany({
    model: buildEmbeddingModel({ provider, model }),
    values: args.texts,
  });

  // Awaited, not fire-and-forget: most callers swallow an embedding failure and
  // continue, so an unawaited write could still be in flight when the request
  // that owns it has already answered.
  if (args.projectId !== null) {
    await recordEmbeddingUsage({
      projectId: args.projectId,
      provider,
      model,
      tokens: usage.tokens,
    });
  }

  return embeddings;
};

export const getEmbedding = async (args: {
  text: string;
  projectId: EmbeddingBillingProjectId;
}): Promise<number[]> => {
  const [embedding] = await getEmbeddings({
    texts: [args.text],
    projectId: args.projectId,
  });
  return embedding;
};
