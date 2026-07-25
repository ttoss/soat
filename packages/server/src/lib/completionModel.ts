import type { LanguageModel } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import { buildModel } from './agentModel';

const log = createDebug('soat:completion-model');

/**
 * Resolves a LanguageModel for an internal system completion (memory
 * extraction, discussion turns) anchored to an agent.
 *
 * By default the agent's own AI provider and model are used. `aiProviderId`
 * switches to another provider — which must belong to the agent's project,
 * otherwise the config could borrow another project's provider secret — and
 * its `default_model` becomes the model fallback. `model` overrides the
 * model name directly.
 */
export const resolveCompletionModel = async (args: {
  agentId: string;
  projectIds?: number[];
  aiProviderId?: string;
  model?: string;
}): Promise<{
  model: LanguageModel;
  modelName: string;
  provider: string;
  /** Attribution for usage metering — internal ids, never surfaced on an API. */
  projectId: number;
  agentDbId: number;
  aiProviderDbId: number;
}> => {
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

  if (args.aiProviderId) {
    const override = await db.AiProvider.findOne({
      where: {
        publicId: args.aiProviderId,
        projectId: typedAgent.project.id as number,
      },
    });
    if (!override) {
      throw new DomainError(
        'AI_PROVIDER_NOT_FOUND',
        `AI provider '${args.aiProviderId}' not found in the agent's project.`
      );
    }
  }

  const providerId = args.aiProviderId ?? typedAgent.aiProvider.publicId;
  const resolved = await resolveAiProviderSecret({ aiProviderId: providerId });

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
    (args.aiProviderId
      ? resolved.defaultModel
      : (typedAgent.model ?? resolved.defaultModel));

  log(
    'resolveCompletionModel: agentId=%s providerId=%s model=%s',
    args.agentId,
    providerId,
    modelName
  );

  const model = await buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: modelName,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  // `TypedAgent` deliberately omits the internal id (one of its constructors
  // builds it from an in-memory pending generation that never had one), so the
  // usage attribution reads it back off the row. `resolveAgentForGeneration`
  // just matched this publicId, so the agent is guaranteed to exist.
  const agentRow = await db.Agent.findOne({
    where: { publicId: args.agentId },
    attributes: ['id'],
  });

  return {
    model,
    modelName,
    provider: resolved.provider,
    projectId: typedAgent.project.id as number,
    agentDbId: agentRow?.id as number,
    aiProviderDbId: resolved.id,
  };
};
