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
 * extraction, reasoning pipeline steps) anchored to an agent.
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
}): Promise<{ model: LanguageModel; modelName: string; provider: string }> => {
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

  return { model, modelName, provider: resolved.provider };
};
