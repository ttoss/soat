import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAI } from '@ai-sdk/openai';
import { type EmbeddingModel, embedMany } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import { resolveBedrockCredentials } from './agentModel';
import type { GenerationEndUser } from './generationAttribution';
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
    // The whole embedding stack is configured by the operator, so an instance
    // role is the intended credential here. The opt-in that gates the same
    // fallback answers for tenant-written provider records, which this is not.
    allowAmbientCredentials: true,
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
      throw new DomainError(
        'EMBEDDING_NOT_CONFIGURED',
        `Unsupported embedding provider: ${args.provider}`
      );
  }
};

const isEmbeddingProvider = (value: string): value is EmbeddingProvider => {
  return value === 'ollama' || value === 'openai' || value === 'bedrock';
};

/**
 * Who an embedding call is billed to. `null` only for an admin's knowledge
 * search naming no project, which spans every project and is not metered.
 *
 * `generationId` is the public id of the generation the embedding is made for —
 * the retrieval ahead of an agent's turn — and `null` for work no generation
 * runs.
 *
 * Required rather than optional at every call site, and both fields with it, so
 * a new caller has to say which it is instead of defaulting into unmetered or
 * unattributed spend.
 */
export type EmbeddingBilling = {
  projectId: number;
  generationId: string | null;
  /** Who work no generation runs is made for — an ingest naming its end user. */
  endUser?: GenerationEndUser;
} | null;

/**
 * The billing of work no generation runs — ingestion, memory writes, the
 * embeddings endpoint, a standalone search — or none when there is no project.
 */
export const projectEmbeddingBilling = (args: {
  projectId: number | null;
  endUser?: GenerationEndUser;
}): EmbeddingBilling => {
  return args.projectId === null
    ? null
    : { projectId: args.projectId, generationId: null, endUser: args.endUser };
};

/**
 * What an embedding is of: a document's chunk, or content written to a memory
 * store. `null` for text nothing stores — a search query, the embeddings
 * endpoint, a scorer's operands. Required, so a new caller has to say.
 */
export type EmbeddingSubject =
  { documentId: number } | { memoryStoreId: number } | null;

/**
 * Embeds `texts` one provider call at a time, as `embedMany` would split them,
 * and settles every call before answering: the provider bills each call that
 * completed, so a batch whose later call fails still reports the tokens the
 * earlier ones spent.
 */
const embedInProviderCalls = async (args: {
  model: EmbeddingModel;
  texts: string[];
}): Promise<{
  embeddings: number[][];
  tokens: number;
  failure: PromiseRejectedResult | undefined;
}> => {
  const perCall =
    typeof args.model === 'string'
      ? undefined
      : await args.model.maxEmbeddingsPerCall;
  const size =
    perCall && Number.isFinite(perCall) ? perCall : args.texts.length || 1;
  const calls: string[][] = [];
  for (let start = 0; start < args.texts.length; start += size) {
    calls.push(args.texts.slice(start, start + size));
  }
  const settled = await Promise.allSettled(
    calls.map((values) => {
      return embedMany({ model: args.model, values });
    })
  );
  let tokens = 0;
  const embeddings: number[][] = [];
  for (const call of settled) {
    if (call.status !== 'fulfilled') continue;
    tokens += Number.isFinite(call.value.usage.tokens)
      ? call.value.usage.tokens
      : 0;
    embeddings.push(...call.value.embeddings);
  }
  const failure = settled.find((call): call is PromiseRejectedResult => {
    return call.status === 'rejected';
  });
  return { embeddings, tokens, failure };
};

export const getEmbeddings = async (args: {
  texts: string[];
  billing: EmbeddingBilling;
  subject: EmbeddingSubject;
}): Promise<number[][]> => {
  const provider = process.env.EMBEDDING_PROVIDER;
  const model = process.env.EMBEDDING_MODEL;

  // `DomainError`, not a bare `Error`: a caller that degrades on an unreachable
  // provider must not also degrade on a server that was never configured. The
  // class is the signal — see `embedQueryOrDegrade`.
  if (!provider || !model) {
    throw new DomainError(
      'EMBEDDING_NOT_CONFIGURED',
      'EMBEDDING_PROVIDER and EMBEDDING_MODEL environment variables must be set'
    );
  }

  if (!isEmbeddingProvider(provider)) {
    throw new DomainError(
      'EMBEDDING_NOT_CONFIGURED',
      `Unsupported embedding provider: ${provider}`
    );
  }

  log(
    'getEmbeddings: provider=%s model=%s count=%d billing=%o',
    provider,
    model,
    args.texts.length,
    args.billing
  );

  const batch = await embedInProviderCalls({
    model: buildEmbeddingModel({ provider, model }),
    texts: args.texts,
  });

  // Awaited, not fire-and-forget: most callers swallow an embedding failure and
  // continue, so an unawaited write could still be in flight when the request
  // that owns it has already answered.
  if (args.billing !== null && batch.tokens > 0) {
    await recordEmbeddingUsage({
      projectId: args.billing.projectId,
      generationId: args.billing.generationId,
      endUser: args.billing.endUser,
      subject: args.subject,
      provider,
      model,
      tokens: batch.tokens,
    });
  }

  if (batch.failure) throw batch.failure.reason;
  return batch.embeddings;
};

export const getEmbedding = async (args: {
  text: string;
  billing: EmbeddingBilling;
  subject: EmbeddingSubject;
}): Promise<number[]> => {
  const [embedding] = await getEmbeddings({
    texts: [args.text],
    billing: args.billing,
    subject: args.subject,
  });
  return embedding;
};
