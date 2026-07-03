import { generateText } from 'ai';
import createDebug from 'debug';

import { resolveCompletionModel } from './completionModel';
import { buildConsolidationPrompt } from './memoryConsolidation';

const log = createDebug('soat:memory-consolidation');

/**
 * Runs the merge-consolidation completion — given an existing memory entry and
 * an incoming fact, returns a single consolidated atomic fact. A plain text
 * completion (no tools, no knowledge injection), so it cannot trigger agent
 * side effects.
 *
 * Provider/model resolution is anchored to an agent and shared with extraction
 * and reasoning via `resolveCompletionModel`, so the manual REST write path —
 * which has no agent context — does not use this and keeps concatenation.
 *
 * Kept in its own module so tests can replace the LLM boundary with
 * `jest.spyOn` while `writeMemoryEntry` runs for real.
 */
export const runConsolidationCompletion = async (args: {
  agentId: string;
  projectIds?: number[];
  existing: string;
  incoming: string;
  aiProviderId?: string;
  model?: string;
}): Promise<string> => {
  const { model, modelName } = await resolveCompletionModel({
    agentId: args.agentId,
    projectIds: args.projectIds,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  log(
    'runConsolidationCompletion: agentId=%s model=%s',
    args.agentId,
    modelName
  );

  const { text } = await generateText({
    model,
    prompt: buildConsolidationPrompt({
      existing: args.existing,
      incoming: args.incoming,
    }),
    temperature: 0,
  });

  return text;
};
