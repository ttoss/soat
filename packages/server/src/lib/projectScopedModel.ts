/**
 * Project-scoped model resolution for completions that have no agent to inherit
 * from (today: the `llm_judge` scorer's judge call).
 *
 * An agent-backed completion resolves its model from the agent's own binding;
 * a project-scoped one has no such owner, so resolution runs against the
 * project: an explicit `aiProviderId` (which must belong to `projectId`, so a
 * config can never borrow another project's provider secret), else the
 * project's `default_model_route_id`.
 */
import type { LanguageModel } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import {
  buildRoutedModel,
  type CompletionAttribution,
  resolveConsumerModelRoute,
} from './modelRoutes';

const log = createDebug('soat:model');

export type ResolvedProjectScopedModel = {
  model: LanguageModel;
  /** Model name for logs — the route id when the call runs through a route. */
  modelName: string;
  /**
   * Billing attribution known *before* the call, or `null` for a route
   * composite, which cannot know its serving target up front — routed callers
   * read it back with `resolveCompletionAttribution` after the call.
   */
  attribution: CompletionAttribution | null;
};

/**
 * Resolves a LanguageModel for a project-scoped completion. `model` overrides
 * the provider's `default_model`, and applies only to the provider case — each
 * route target names its own model.
 */
export const resolveProjectScopedModel = async (args: {
  projectId: number;
  aiProviderId?: string | null;
  model?: string | null;
}): Promise<ResolvedProjectScopedModel> => {
  const route = await resolveConsumerModelRoute({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
  });

  if (route) {
    log(
      'resolveProjectScopedModel: projectId=%d routeId=%s',
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
      "This completion resolves neither an AI provider nor a model route; pin an ai_provider_id or set the project's default_model_route_id."
    );
  }

  const provider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId, projectId: args.projectId },
  });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found in the project.`
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
    'resolveProjectScopedModel: projectId=%d providerId=%s model=%s',
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
