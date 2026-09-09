import { DomainError } from '../errors';
import { pendingGenerations } from './agentGenerationHelpers';
import { recoverPendingFromDb } from './agentGenerationRecovery';
import {
  type GenerationResult,
  type PendingGeneration,
} from './agentGenerationTypes';
import {
  buildSyntheticToolResultMessages,
  buildToolResultMessages,
  loadOutputMappingsByToolName,
  resolveToolOutputsResult,
  runToolOutputsGeneration,
} from './agentNonStreamGeneration';
import {
  collectSystemInstructions,
  withoutSystemMessages,
} from './modelMessages';

/**
 * The ids a caller may answer are the ones this pause opened.
 *
 * A tool result is not caller data: it enters the conversation as the output of
 * a call the model itself made, and the model reasons on it with that
 * standing — so an id the pause never opened is a result for a call that was
 * never made, written straight into the turn.
 *
 * `pendingToolCalls` is exactly the right list, because the guardrail gate
 * already partitions on it: a client call the gate parks or blocks is left out
 * and answered by a synthesized result instead, so answering it here would
 * override the refusal the gate wrote.
 *
 * Checked before the pending entry is consumed, so a refused submission leaves
 * the generation resumable rather than spending it.
 */
const assertToolOutputsWereOpened = (args: {
  toolOutputs: Array<{ toolCallId: string }>;
  pendingToolCalls: PendingGeneration['pendingToolCalls'];
}): void => {
  const open = new Set(
    args.pendingToolCalls.map((toolCall) => {
      return toolCall.toolCallId;
    })
  );
  const unknown = args.toolOutputs
    .map((output) => {
      return output.toolCallId;
    })
    .filter((toolCallId) => {
      return !open.has(toolCallId);
    });
  if (unknown.length === 0) return;

  throw new DomainError(
    'VALIDATION_FAILED',
    `No tool call is awaiting a result for: ${unknown.join(', ')}. Only the calls this generation paused on can be answered.`
  );
};

/**
 * Whether a paused generation is one this caller may answer.
 *
 * `recoverPendingFromDb` scopes its own lookup, so this is the in-memory
 * branch's half of the same rule: the pending map is process-wide and keyed by
 * generation id alone, so without it any caller who could name a generation
 * could resume one belonging to another project. What that resumes is not
 * merely a read — the pending entry holds tool closures built with the original
 * caller's auth header, so the continuation runs on their credentials.
 *
 * `undefined` is the unrestricted principal, exactly as everywhere else the
 * project scope is threaded, and is what the session path relies on: it
 * authorizes the session first and names no project set here.
 */
const isWithinProjectScope = (args: {
  projectIds?: number[];
  projectId: number;
}): boolean => {
  if (args.projectIds === undefined) return true;
  return args.projectIds.includes(args.projectId);
};

export const submitToolOutputs = async (args: {
  projectIds?: number[];
  agentId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
  authHeader?: string;
}): Promise<GenerationResult> => {
  let pending = pendingGenerations.get(args.generationId);

  // If not in memory (e.g. server restarted), recover from DB.
  if (!pending) {
    pending = await recoverPendingFromDb({
      generationId: args.generationId,
      agentId: args.agentId,
      projectIds: args.projectIds,
      authHeader: args.authHeader,
    });
  }
  if (
    !pending ||
    pending.agentId !== args.agentId ||
    !isWithinProjectScope({
      projectIds: args.projectIds,
      projectId: pending.projectId,
    })
  ) {
    throw new DomainError(
      'GENERATION_NOT_FOUND',
      `Generation '${args.generationId}' not found or does not belong to agent '${args.agentId}'.`
    );
  }

  assertToolOutputsWereOpened({
    toolOutputs: args.toolOutputs,
    pendingToolCalls: pending.pendingToolCalls,
  });

  pendingGenerations.delete(args.generationId);

  const toolResultMessages = buildToolResultMessages({
    toolOutputs: args.toolOutputs,
    pendingToolCalls: pending.pendingToolCalls,
    outputMappingsByToolName: await loadOutputMappingsByToolName(pending),
  });
  // Merge the results the guardrail gate synthesized for client calls it did not
  // release (class D / tripwire / pending_approval). They belong to the same
  // assistant turn, so the provider needs them alongside the client's outputs.
  const syntheticMessages = buildSyntheticToolResultMessages(
    pending.syntheticToolResults ?? []
  );
  const allMessages = [
    ...pending.messages,
    ...toolResultMessages,
    ...syntheticMessages,
  ];
  const system = collectSystemInstructions(pending.messages);
  const nonSystemMessages = withoutSystemMessages(allMessages);

  const result = await runToolOutputsGeneration({
    generationId: args.generationId,
    pending,
    system,
    nonSystemMessages,
  });

  return resolveToolOutputsResult({
    generationId: args.generationId,
    agentId: args.agentId,
    pending,
    allMessages,
    result,
  });
};
