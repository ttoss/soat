import { generateText, type JSONValue, type LanguageModel } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import type { DiscussionEffort } from './discussionEngine';
import {
  buildRoutedModel,
  type CompletionAttribution,
  meterCompletion,
  resolveConsumerModelRoute,
  routedMaxRetries,
} from './modelRoutes';

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

export type ResolvedDiscussionModel = {
  model: LanguageModel;
  /** Model name for logs — the route id when the turn runs through a route. */
  modelName: string;
  /**
   * Billing attribution known *before* the call, or `null` for a route
   * composite, which cannot know its serving target up front — routed callers
   * read it back with `resolveCompletionAttribution` after the call.
   */
  attribution: CompletionAttribution | null;
};

/**
 * Resolves a LanguageModel for a discussion completion. Unlike the agent-based
 * resolver, a discussion has no agent to inherit from — resolution is
 * project-scoped: an explicit `aiProviderId` (which must belong to `projectId`,
 * so a config can never borrow another project's provider secret), else the
 * project's `default_model_route_id`. `model` overrides the provider's
 * `default_model`, and applies only to the provider case — each route target
 * names its own model.
 */
export const resolveDiscussionModel = async (args: {
  projectId: number;
  aiProviderId?: string | null;
  model?: string | null;
}): Promise<ResolvedDiscussionModel> => {
  const route = await resolveConsumerModelRoute({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
  });

  if (route) {
    log(
      'resolveDiscussionModel: projectId=%d routeId=%s',
      args.projectId,
      route.id
    );
    return {
      model: await buildRoutedModel({ route }),
      modelName: route.id,
      attribution: null,
    };
  }

  // The write-time guards leave a pinned provider as the only remaining
  // possibility once no route resolves.
  /* istanbul ignore next */
  if (!args.aiProviderId) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      "This discussion turn resolves neither an AI provider nor a model route; pin an ai_provider_id or set the project's default_model_route_id."
    );
  }

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

  return {
    model,
    modelName,
    attribution: {
      provider: resolved.provider,
      modelName,
      aiProviderDbId: provider.id as number,
    },
  };
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
  aiProviderId?: string | null;
  prompt: string;
  model?: string | null;
  temperature?: number;
  effort?: DiscussionEffort;
  /** Aborts the completion (e.g. a per-turn timeout) so it cannot hang. */
  abortSignal?: AbortSignal;
}): Promise<string> => {
  const { model, modelName, attribution } = await resolveDiscussionModel({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  // Reasoning options are provider-native, and a route's targets may span
  // providers that disagree about them — so a routed turn treats `effort` as the
  // no-op it already is for a provider without a mapping, rather than sending
  // one provider's options to whichever target serves.
  const options = attribution
    ? buildDiscussionProviderOptions({
        provider: attribution.provider,
        effort: args.effort,
      })
    : undefined;

  log(
    'runDiscussionCompletion: projectId=%d model=%s effort=%s',
    args.projectId,
    modelName,
    args.effort
  );

  const { text, usage } = await generateText({
    model,
    prompt: args.prompt,
    temperature: args.temperature ?? 0,
    abortSignal: args.abortSignal,
    // A routed model owns every attempt itself (see `routedMaxRetries`); a
    // pinned one keeps the discussion path's own single retry.
    maxRetries: routedMaxRetries(model) ?? 1,
    ...(options
      ? {
          providerOptions: options.providerOptions,
          ...(options.maxOutputTokens
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
        }
      : {}),
  });

  // A discussion turn is a real provider call, so it meters like any other —
  // against the target that actually served when the turn ran through a route.
  meterCompletion({
    model,
    fallback: attribution,
    source: 'discussion',
    projectId: args.projectId,
    pinnedModel: modelName,
    usage,
  });

  return text;
};
