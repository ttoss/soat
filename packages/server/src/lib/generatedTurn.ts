import createDebug from 'debug';

import { mapGenerationRequiredAction } from './agentGenerationHelpers';
import type { GenerateConversationMessageResult } from './conversationGeneration';

const log = createDebug('soat:generated-turn');

/**
 * The wire answer of a generated conversation turn, whichever route ran it:
 * conversation generate, session generate and a session's tool-outputs. A
 * completed turn carries the stored message record its conversation lists; a
 * paused turn has stored nothing, so it carries no `message`.
 */
export const mapGeneratedTurn = (result: GenerateConversationMessageResult) => {
  log(
    'mapGeneratedTurn: generationId=%s status=%s',
    result.generationId,
    result.status
  );
  if (result.status === 'requires_action') {
    return {
      status: result.status,
      generation_id: result.generationId,
      trace_id: result.traceId,
      required_action: mapGenerationRequiredAction(result.requiredAction),
    };
  }
  return {
    status: result.status,
    content: result.content,
    message: result.message,
    generation_id: result.generationId,
    trace_id: result.traceId,
    model: result.model,
  };
};
