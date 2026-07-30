import type { LanguageModel, LanguageModelUsage } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import {
  buildRoutedModel,
  type CompletionAttribution,
  meterCompletion,
  type ModelRouteConfig,
} from './modelRoutes';

/**
 * Everything a chat completion needs to both call the provider and meter the
 * call: the built model plus the billing attribution (provider instance, slug,
 * resolved model name) that `recordCompletionUsage` writes.
 *
 * `attribution` is `null` when the model is a route composite — a composite
 * cannot know which target will serve, so `meterChatCompletion` reads the served
 * target back from the routing metadata once the call has returned.
 *
 * Kept beside the metering helper so every chat path — stateless or
 * chat-scoped, streaming or not — resolves and meters the same way.
 */
export type ResolvedChatModel = {
  model: LanguageModel;
  /** Model name for logs — the route id when the call runs through a route. */
  modelName: string;
  projectId: number;
  attribution: CompletionAttribution | null;
};

type ResolvedAiProviderSecret = NonNullable<
  Awaited<ReturnType<typeof resolveAiProviderSecret>>
>;

/**
 * Builds the model and its metering attribution from an already-resolved
 * provider secret. The chat-scoped routes resolve the secret themselves (they
 * read the provider off the chat row), so they call this directly instead of
 * `resolveChatModel`.
 */
export const buildResolvedChatModel = (args: {
  resolved: ResolvedAiProviderSecret;
  modelName: string;
}): ResolvedChatModel => {
  const { resolved } = args;
  return {
    model: buildModel({
      provider: resolved.provider,
      secretValue: resolved.secretValue,
      model: args.modelName,
      baseUrl: resolved.baseUrl,
      config: resolved.config as Record<string, unknown> | undefined,
    }),
    modelName: args.modelName,
    projectId: resolved.projectId,
    attribution: {
      provider: resolved.provider,
      modelName: args.modelName,
      aiProviderDbId: resolved.id,
    },
  };
};

/**
 * Builds the composite model for a chat that pins no provider and therefore
 * inherits its project's `default_model_route_id`. Each target names its own
 * model, so a request-level `model` cannot apply here — the write-time binding
 * guard already rejects that combination.
 */
export const buildRoutedChatModel = async (args: {
  projectId: number;
  route: ModelRouteConfig;
}): Promise<ResolvedChatModel> => {
  return {
    model: await buildRoutedModel({ route: args.route }),
    modelName: args.route.id,
    projectId: args.projectId,
    attribution: null,
  };
};

/**
 * Resolves the model for a **stateless** chat completion (`POST
 * /chat/completions`), which names its provider per request and belongs to no
 * chat. It has no project of its own to inherit a default route from — the
 * project is derived *from* the provider — so `ai_provider_id` stays required
 * here. Chat-scoped completions follow the inheritance chain instead
 * (`resolveChatScopedModel` in `chats.ts`).
 */
export const resolveChatModel = async (args: {
  aiProviderId: string;
  model?: string;
}): Promise<ResolvedChatModel> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.aiProviderId,
  });

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found or not configured.`
    );
  }

  return buildResolvedChatModel({
    resolved,
    modelName: args.model ?? resolved.defaultModel,
  });
};

/**
 * Meters one chat completion, against the target that actually served when the
 * call ran through a route. Fire-and-forget — see `meterCompletion`.
 */
export const meterChatCompletion = (args: {
  resolved: ResolvedChatModel;
  model: string | undefined;
  usage: LanguageModelUsage | undefined;
}): void => {
  meterCompletion({
    model: args.resolved.model,
    fallback: args.resolved.attribution,
    source: 'chat',
    projectId: args.resolved.projectId,
    pinnedModel: args.model,
    usage: args.usage,
  });
};
