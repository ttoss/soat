import { generateText, type JSONValue, type LanguageModel } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import type { DiscussionEffort } from './discussionEngine';

const log = createDebug('soat:discussions');

export type ProviderOptionsMap = Record<string, Record<string, JSONValue>>;

export type DiscussionProviderOptions = {
  providerOptions: ProviderOptionsMap;
  /** Anthropic requires max_tokens to exceed the thinking budget. */
  maxOutputTokens?: number;
};

const EFFORT_BUDGET_TOKENS: Record<DiscussionEffort, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
};

/**
 * Maps a participant/synthesis `effort` level to provider-native reasoning
 * options (relocated here from the removed agent thinking config). Returns
 * undefined for providers without a supported mapping — effort is then a no-op
 * rather than an error.
 */
export const buildDiscussionProviderOptions = (args: {
  provider: string;
  effort?: DiscussionEffort;
}): DiscussionProviderOptions | undefined => {
  const budget = args.effort ? EFFORT_BUDGET_TOKENS[args.effort] : undefined;
  if (!args.effort || !budget) return undefined;

  if (args.provider === 'openai') {
    return { providerOptions: { openai: { reasoningEffort: args.effort } } };
  }
  if (args.provider === 'anthropic') {
    return {
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: budget } },
      },
      maxOutputTokens: budget + 8192,
    };
  }
  if (args.provider === 'google') {
    return {
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: budget } },
      },
    };
  }

  log(
    'buildDiscussionProviderOptions: no mapping provider=%s effort=%s',
    args.provider,
    args.effort
  );
  return undefined;
};

/**
 * Resolves a LanguageModel for a discussion completion. Unlike the agent-based
 * resolver, a discussion has no agent to inherit from — the provider is always
 * project-scoped. The `aiProviderId` must belong to `projectId`, so a config
 * can never borrow another project's provider secret. `model` overrides the
 * provider's `default_model`.
 */
export const resolveDiscussionModel = async (args: {
  projectId: number;
  aiProviderId: string;
  model?: string | null;
}): Promise<{ model: LanguageModel; modelName: string; provider: string }> => {
  const provider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId, projectId: args.projectId },
  });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found in the discussion's project.`
    );
  }

  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.aiProviderId,
  });
  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' could not be resolved.`
    );
  }

  const modelName = args.model ?? resolved.defaultModel;

  log(
    'resolveDiscussionModel: projectId=%d providerId=%s model=%s',
    args.projectId,
    args.aiProviderId,
    modelName
  );

  const model = await buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: modelName,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  return { model, modelName, provider: resolved.provider };
};

/**
 * Runs a single discussion turn (a participant or the synthesis) as a plain
 * text completion — no tools, no knowledge injection — so a participant cannot
 * trigger side effects.
 *
 * Kept in its own module so tests can replace the LLM boundary with
 * `jest.spyOn` while the orchestration in `discussionEngine.ts` runs for real.
 */
export const runDiscussionCompletion = async (args: {
  projectId: number;
  aiProviderId: string;
  prompt: string;
  model?: string | null;
  temperature?: number;
  effort?: DiscussionEffort;
  /** Aborts the completion (e.g. a per-turn timeout) so it cannot hang. */
  abortSignal?: AbortSignal;
}): Promise<string> => {
  const { model, modelName, provider } = await resolveDiscussionModel({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  const options = buildDiscussionProviderOptions({
    provider,
    effort: args.effort,
  });

  log(
    'runDiscussionCompletion: projectId=%d model=%s effort=%s',
    args.projectId,
    modelName,
    args.effort
  );

  const { text } = await generateText({
    model,
    prompt: args.prompt,
    temperature: args.temperature ?? 0,
    abortSignal: args.abortSignal,
    maxRetries: 1,
    ...(options
      ? {
          providerOptions: options.providerOptions,
          ...(options.maxOutputTokens
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
        }
      : {}),
  });

  return text;
};
