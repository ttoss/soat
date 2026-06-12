import { generateText } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import { buildModel } from './agentModel';

const log = createDebug('soat:memory-extraction');

/**
 * Runs the fact-extraction completion as a plain text completion — no tools,
 * no knowledge injection — so the extraction prompt cannot trigger agent side
 * effects.
 *
 * By default the agent's own AI provider and model are used. `aiProviderId`
 * switches to another provider in the same project (its `default_model`
 * becomes the fallback), and `model` overrides the model name directly.
 *
 * Kept in its own module so tests can replace the LLM boundary with
 * `jest.spyOn` while the orchestration in `memoryExtraction.ts` runs for real.
 */
export const runExtractionCompletion = async (args: {
  agentId: string;
  projectIds?: number[];
  prompt: string;
  aiProviderId?: string;
  model?: string;
}): Promise<string> => {
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

  // A provider override must belong to the agent's project — otherwise an
  // agent config could borrow another project's provider secret.
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
        `Extraction AI provider '${args.aiProviderId}' not found in the agent's project.`
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
  const model =
    args.model ??
    (args.aiProviderId
      ? resolved.defaultModel
      : (typedAgent.model ?? resolved.defaultModel));

  const resolvedModel = await buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  log(
    'runExtractionCompletion: agentId=%s providerId=%s model=%s',
    args.agentId,
    providerId,
    model
  );

  const { text } = await generateText({
    model: resolvedModel,
    prompt: args.prompt,
    temperature: 0,
  });

  return text;
};
