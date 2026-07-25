import type { LanguageModel, LanguageModelUsage } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { buildModel } from './agentModel';
import { recordCompletionUsage } from './usage';

/**
 * Everything a chat completion needs to both call the provider and meter the
 * call: the built model plus the billing attribution (project, provider
 * instance, slug, resolved model name) that `recordCompletionUsage` writes.
 *
 * Kept beside the metering helper so every chat path — stateless or
 * chat-scoped, streaming or not — resolves and meters the same way.
 */
export type ResolvedChatModel = {
  model: LanguageModel;
  modelName: string;
  provider: string;
  projectId: number;
  aiProviderDbId: number;
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
    provider: resolved.provider,
    projectId: resolved.projectId,
    aiProviderDbId: resolved.id,
  };
};

export const resolveChatModel = async (args: {
  aiProviderId: string;
  model?: string;
}): Promise<ResolvedChatModel> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.aiProviderId,
  });

  if (!resolved) {
    throw new Error('AI provider not found');
  }

  return buildResolvedChatModel({
    resolved,
    modelName: args.model ?? resolved.defaultModel,
  });
};

/**
 * Meters one chat completion. `recordCompletionUsage` never rejects (it catches
 * internally), so `void` marks the intentional fire-and-forget: metering must
 * never delay or fail the completion it measures.
 */
export const meterChatCompletion = (args: {
  resolved: ResolvedChatModel;
  model: string | undefined;
  usage: LanguageModelUsage | undefined;
}): void => {
  void recordCompletionUsage({
    source: 'chat',
    projectId: args.resolved.projectId,
    provider: args.resolved.provider,
    aiProviderId: args.resolved.aiProviderDbId,
    model: args.model ?? args.resolved.modelName,
    usage: args.usage,
  });
};
