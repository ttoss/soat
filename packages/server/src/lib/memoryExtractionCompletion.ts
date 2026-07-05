import { generateText } from 'ai';
import createDebug from 'debug';

import { resolveCompletionModel } from './completionModel';

const log = createDebug('soat:memory-extraction');

/**
 * Runs the fact-extraction completion as a plain text completion — no tools,
 * no knowledge injection — so the extraction prompt cannot trigger agent side
 * effects.
 *
 * Provider/model resolution (including the project-scope check for
 * `aiProviderId` overrides) is shared via `resolveCompletionModel`.
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
  const { model, modelName } = await resolveCompletionModel({
    agentId: args.agentId,
    projectIds: args.projectIds,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  log('runExtractionCompletion: agentId=%s model=%s', args.agentId, modelName);

  const { text } = await generateText({
    model,
    prompt: args.prompt,
    temperature: 0,
  });

  return text;
};
