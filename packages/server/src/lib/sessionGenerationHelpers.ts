import type { db } from '../db';
import type { GenerationResult } from './agents';
import { addConversationMessage } from './conversationMessages';
import { emitEvent, resolveProjectPublicId } from './eventBus';

export const emitGenerationStarted = (
  session: InstanceType<(typeof db)['Session']>
) => {
  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.generation.started',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: { sessionId: session.publicId },
        timestamp: new Date().toISOString(),
      });
    }
  );
};

export const emitGenerationRequiresAction = (args: {
  session: InstanceType<(typeof db)['Session']>;
  generationId: string;
  traceId: string;
}) => {
  resolveProjectPublicId({ projectId: args.session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.generation.requires_action',
        projectId: args.session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: args.session.publicId,
        data: {
          sessionId: args.session.publicId,
          generationId: args.generationId,
          traceId: args.traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );
};

export const emitGenerationCompleted = (args: {
  session: InstanceType<(typeof db)['Session']>;
  generationId: string;
  traceId: string;
}) => {
  resolveProjectPublicId({ projectId: args.session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.generation.completed',
        projectId: args.session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: args.session.publicId,
        data: {
          sessionId: args.session.publicId,
          generationId: args.generationId,
          traceId: args.traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );
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
      metadata:
        responseMessages && responseMessages.length > 0
          ? { responseMessages }
          : undefined,
    });
  }

  if (args.result.status === 'requires_action') {
    return {
      status: 'requires_action' as const,
      generationId: args.result.id,
      traceId: args.result.traceId,
      requiredAction: args.result.requiredAction!,
    };
  }

  return {
    status: 'completed' as const,
    message: {
      role: 'assistant' as const,
      content: args.result.output?.content ?? '',
      model: args.result.output?.model,
    },
    generationId: args.result.id,
    traceId: args.result.traceId,
  };
};
