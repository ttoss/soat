import { generateText } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { DomainError } from '../errors';
import { resolveAgentForGeneration } from './agentGenerationRecovery';
import { buildModel } from './agentModel';

const log = createDebug('soat:memory-extraction');

/**
 * Runs the fact-extraction completion against the agent's own AI provider
 * and model. This is a plain text completion — no tools, no knowledge
 * injection — so the extraction prompt cannot trigger agent side effects.
 *
 * Kept in its own module so tests can replace the LLM boundary with
 * `jest.spyOn` while the orchestration in `memoryExtraction.ts` runs for real.
 */
export const runExtractionCompletion = async (args: {
  agentId: string;
  projectIds?: number[];
  prompt: string;
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

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedAgent.aiProvider.publicId,
  });

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider for agent '${args.agentId}' could not be resolved.`
    );
  }

  const model = await buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  log('runExtractionCompletion: agentId=%s', args.agentId);

  const { text } = await generateText({
    model,
    prompt: args.prompt,
    temperature: 0,
  });

  return text;
};
