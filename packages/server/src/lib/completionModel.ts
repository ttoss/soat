import type { LanguageModel } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import { buildModel } from './agentModel';
import {
  buildRoutedModel,
  type CompletionAttribution,
  resolveConsumerModelRoute,
} from './modelRoutes';

const log = createDebug('soat:completion-model');

export type ResolvedCompletionModel = {
  model: LanguageModel;
  /** Model name for logs — the route id when the call runs through a route. */
  modelName: string;
  /** Attribution for usage metering — internal ids, never surfaced on an API. */
  projectId: number;
  agentDbId: number;
  /**
   * Billing attribution known *before* the call, or `null` when the model is a
   * route composite: a composite cannot know which target will serve, so routed
   * callers read attribution back with `resolveCompletionAttribution` once the
   * call returns.
   */
  attribution: CompletionAttribution | null;
};

/**
 * An `aiProviderId` override must belong to the agent's project, otherwise the
 * completion config could borrow another project's provider secret.
 */
const assertOverrideInProject = async (args: {
  aiProviderId: string;
  projectId: number;
}): Promise<void> => {
  const override = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId, projectId: args.projectId },
  });
  if (!override) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found in the agent's project.`
    );
  }
};

/** Builds the pinned-provider arm of the chain: the tail once no route applies. */
const resolvePinnedCompletionModel = async (args: {
  agentId: string;
  providerId: string;
  /** True when the provider came from the config override, not the agent's pin. */
  isOverride: boolean;
  agentModel?: string | null;
  model?: string;
}): Promise<{ model: LanguageModel; attribution: CompletionAttribution }> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.providerId,
  });

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider for agent '${args.agentId}' could not be resolved.`
    );
  }

  // With a provider override, the agent's model name is likely meaningless on
  // the other provider — fall back to that provider's default_model instead.
  const modelName =
    args.model ??
    (args.isOverride
      ? resolved.defaultModel
      : (args.agentModel ?? resolved.defaultModel));

  log(
    'resolveCompletionModel: agentId=%s providerId=%s model=%s',
    args.agentId,
    args.providerId,
    modelName
  );

  return {
    model: await buildModel({
      provider: resolved.provider,
      secretValue: resolved.secretValue,
      model: modelName,
      baseUrl: resolved.baseUrl,
      config: resolved.config as Record<string, unknown> | undefined,
    }),
    attribution: {
      provider: resolved.provider,
      modelName,
      aiProviderDbId: resolved.id,
    },
  };
};

/**
 * Loads the agent a completion is anchored to, validates the config's provider
 * override against its project, and reads back the internal ids metering needs.
 *
 * `TypedAgent` deliberately omits the internal id (one of its constructors
 * builds it from an in-memory pending generation that never had one), so the
 * usage attribution reads it back off the row. `resolveAgentForGeneration` just
 * matched this publicId, so the agent is guaranteed to exist.
 */
const loadCompletionAgent = async (args: {
  agentId: string;
  projectIds?: number[];
  aiProviderId?: string;
}) => {
  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });

  if (!typedAgent) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }

  const projectId = typedAgent.project.id as number;

  if (args.aiProviderId) {
    await assertOverrideInProject({
      aiProviderId: args.aiProviderId,
      projectId,
    });
  }

  const agentRow = await db.Agent.findOne({
    where: { publicId: args.agentId },
    attributes: ['id'],
  });

  return { typedAgent, projectId, agentDbId: agentRow?.id as number };
};

/**
 * Resolves a LanguageModel for an internal system completion (memory
 * extraction, consolidation) anchored to an agent.
 *
 * Resolution follows the same chain as an agent generation, with the completion
 * config's own override in front: explicit `aiProviderId` → the agent's pinned
 * provider → the agent's model route → the project's default route. `model`
 * overrides the model name, and only applies to the provider cases — each route
 * target names its own model.
 *
 * An `aiProviderId` override must belong to the agent's project, otherwise the
 * config could borrow another project's provider secret.
 */
export const resolveCompletionModel = async (args: {
  agentId: string;
  projectIds?: number[];
  aiProviderId?: string;
  model?: string;
}): Promise<ResolvedCompletionModel> => {
  const { typedAgent, projectId, agentDbId } = await loadCompletionAgent(args);

  const route = await resolveConsumerModelRoute({
    projectId,
    modelRouteId: typedAgent.modelRoute?.publicId,
    // An explicit override, like a pin, short-circuits the chain.
    aiProviderId: args.aiProviderId ?? typedAgent.aiProvider?.publicId,
  });

  if (route) {
    log(
      'resolveCompletionModel: agentId=%s routeId=%s',
      args.agentId,
      route.id
    );
    return {
      model: await buildRoutedModel({ route }),
      modelName: route.id,
      projectId,
      agentDbId,
      attribution: null,
    };
  }

  const providerId = args.aiProviderId ?? typedAgent.aiProvider?.publicId;
  // The write-time guards leave a pin as the only remaining possibility once no
  // route resolves; this only fires if a row violates them.
  /* istanbul ignore next */
  if (!providerId) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `Agent '${args.agentId}' resolves neither an AI provider nor a model route for this completion.`
    );
  }

  const { model, attribution } = await resolvePinnedCompletionModel({
    agentId: args.agentId,
    providerId,
    isOverride: Boolean(args.aiProviderId),
    agentModel: typedAgent.model,
    model: args.model,
  });

  return {
    model,
    modelName: attribution.modelName,
    projectId,
    agentDbId,
    attribution,
  };
};
