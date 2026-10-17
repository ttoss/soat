import createDebug from 'debug';

import type { db } from '../db';
import { DomainError } from '../errors';
import type { GenerationResult } from './agentGenerationTypes';
import { addConversationMessage } from './conversationMessages';
import { mapGeneratedTurn } from './generatedTurn';
import { emitSessionEvent } from './sessionEvents';

const log = createDebug('soat:session-generation');

export const emitGenerationStarted = (
  session: InstanceType<(typeof db)['Session']>
) => {
  void emitSessionEvent({ type: 'sessions.generation_started', session });
};

// A completed turn is stored even when it carries no text, as conversation
// generate stores it: the reply always names the record it produced.
export const processToolOutputResult = async (args: {
  result: GenerationResult;
  conversation: InstanceType<(typeof db)['Conversation']>;
  agentPublicId: string;
}) => {
  const { result } = args;
  log(
    'processToolOutputResult: generationId=%s status=%s',
    result.id,
    result.status
  );
  if (result.status === 'requires_action') {
    return mapGeneratedTurn({
      status: 'requires_action',
      generationId: result.id,
      traceId: result.traceId,
      requiredAction: result.requiredAction!,
    });
  }

  const content = result.output?.content ?? '';
  const responseMessages = result.output?.responseMessages;
  const message = await addConversationMessage({
    conversationId: args.conversation.publicId,
    message: content,
    role: 'assistant',
    agentId: args.agentPublicId,
    responseMessages:
      responseMessages && responseMessages.length > 0
        ? responseMessages
        : undefined,
  });

  if (!message) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
  }

  return mapGeneratedTurn({
    status: 'completed',
    content,
    message,
    generationId: result.id,
    traceId: result.traceId,
    model: result.output?.model,
  });
};
