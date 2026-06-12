import { generateText } from 'ai';
import createDebug from 'debug';

import { resolveCompletionModel } from './completionModel';

const log = createDebug('soat:reasoning');

/**
 * Runs a reasoning step (critique or revision) as a plain text completion —
 * no tools, no knowledge injection — so reflection cannot trigger agent side
 * effects.
 *
 * Kept in its own module so tests can replace the LLM boundary with
 * `jest.spyOn` while the orchestration in `reasoning.ts` runs for real.
 */
export const runReasoningCompletion = async (args: {
  agentId: string;
  projectIds?: number[];
  prompt: string;
  aiProviderId?: string;
  model?: string;
  temperature?: number;
}): Promise<string> => {
  const { model, modelName } = await resolveCompletionModel({
    agentId: args.agentId,
    projectIds: args.projectIds,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  log('runReasoningCompletion: agentId=%s model=%s', args.agentId, modelName);

  const { text } = await generateText({
    model,
    prompt: args.prompt,
    temperature: args.temperature ?? 0,
  });

  return text;
};
