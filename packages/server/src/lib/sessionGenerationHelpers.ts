import type { db } from '../db';
import { mapGenerationRequiredAction } from './agentGenerationHelpers';
import type { GenerationResult } from './agents';
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

export const emitGenerationRequiresAction = (args: {
  session: InstanceType<(typeof db)['Session']>;
  generationId: string;
  traceId: string;
}) => {
  emitResourceEvent({
    type: 'sessions.generation.requires_action',
    projectId: args.session.projectId,
    resourceType: 'session',
    resourceId: args.session.publicId,
    data: {
      sessionId: args.session.publicId,
      generationId: args.generationId,
      traceId: args.traceId,
    },
  });
};

export const emitGenerationCompleted = (args: {
  session: InstanceType<(typeof db)['Session']>;
  generationId: string;
  traceId: string;
}) => {
  emitResourceEvent({
    type: 'sessions.generation.completed',
    projectId: args.session.projectId,
    resourceType: 'session',
    resourceId: args.session.publicId,
    data: {
      sessionId: args.session.publicId,
      generationId: args.generationId,
      traceId: args.traceId,
    },
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
