import type { db } from '../db';
import { mapGenerationRequiredAction } from './agentGenerationHelpers';
import type { GenerationResult } from './agentGenerationTypes';
import { addConversationMessage } from './conversationMessages';
import { emitResourceEvent } from './eventBus';

export const emitGenerationStarted = (
  session: InstanceType<(typeof db)['Session']>
) => {
  emitResourceEvent({
    type: 'sessions.generation.started',
    projectId: session.projectId,
    resourceType: 'session',
    resourceId: session.publicId,
    data: { sessionId: session.publicId },
  });
};

export const processToolOutputResult = async (args: {
  result: GenerationResult;
  conversation: InstanceType<(typeof db)['Conversation']>;
  agentPublicId: string;
}) => {
  if (args.result.status === 'completed' && args.result.output?.content) {
    const responseMessages = args.result.output.responseMessages;
    await addConversationMessage({
      conversationId: args.conversation.publicId,
      message: args.result.output.content,
      role: 'assistant',
      agentId: args.agentPublicId,
      responseMessages:
        responseMessages && responseMessages.length > 0
          ? responseMessages
          : undefined,
    });
  }

  if (args.result.status === 'requires_action') {
    return {
      status: 'requires_action' as const,
      generation_id: args.result.id,
      trace_id: args.result.traceId,
      required_action: mapGenerationRequiredAction(args.result.requiredAction!),
    };
  }

  return {
    status: 'completed' as const,
    message: {
      role: 'assistant' as const,
      content: args.result.output?.content ?? '',
      model: args.result.output?.model,
    },
    generation_id: args.result.id,
    trace_id: args.result.traceId,
  };
};
