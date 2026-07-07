import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration, type GenerationResult } from './agents';
import { addConversationMessage } from './conversationMessages';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { readFileBuffer } from './fileStorage';
import { fireMemoryExtraction } from './memoryExtraction';

type ConversationMessage = InstanceType<(typeof db)['ConversationMessage']> & {
  document?: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']>;
  };
  actor?: InstanceType<(typeof db)['Actor']> | null;
};

type GenerationContext = {
  conversation: InstanceType<(typeof db)['Conversation']>;
  generatingAgent: InstanceType<(typeof db)['Agent']>;
  messages: Array<ConversationMessage>;
  snapshotPosition: number;
};

const readMessageContent = async (
  msg: ConversationMessage
): Promise<string> => {
  const file = msg.document?.file;
  if (!file?.storagePath) {
    return '';
  }
  const buffer = await readFileBuffer({
    storageType: file.storageType,
    storagePath: file.storagePath,
  });
  return buffer ? buffer.toString('utf-8') : '';
};

const buildMessageEntry = async (args: {
  msg: ConversationMessage;
}): Promise<{ role: string; content: string }> => {
  const content = await readMessageContent(args.msg);
  if (args.msg.role === 'assistant') {
    return { role: 'assistant', content };
  }
  const speakerName = args.msg.actor?.name ?? 'participant';
  const meta = (args.msg as { metadata?: Record<string, unknown> | null })
    .metadata;
  const metadataStr =
    meta && Object.keys(meta).length > 0 && !meta.responseMessages
      ? ` [${Object.entries(meta)
          .filter(([k]) => {
            return k !== 'responseMessages';
          })
          .map(([k, v]) => {
            return `${k}: ${v}`;
          })
          .join(', ')}]`
      : '';
  return {
    role: 'user',
    content: `[${speakerName}]${metadataStr}: ${content}`,
  };
};

const buildConversationHistory = async (args: {
  messages: Array<ConversationMessage>;
}): Promise<Array<{ role: string; content: unknown }>> => {
  const entries = await Promise.all(
    args.messages.map(async (msg) => {
      const meta = (msg as { metadata?: Record<string, unknown> | null })
        .metadata;
      const responseMessages = meta?.responseMessages;
      // Expand stored AI SDK response messages (tool calls, tool results, final
      // text) so the LLM sees the full tool-use chain on subsequent turns.
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        return responseMessages as Array<{ role: string; content: unknown }>;
      }
      return [await buildMessageEntry({ msg })];
    })
  );
  return entries.flat();
};

type InternalGenerationResult =
  | {
      status: 'completed';
      generationId: string;
      traceId: string;
      content: string;
      model: string;
      output?: GenerationResult['output'];
    }
  | {
      status: 'requires_action';
      generationId: string;
      traceId: string;
      requiredAction: NonNullable<GenerationResult['requiredAction']>;
    };

const runAgentGeneration = async (args: {
  agent: InstanceType<(typeof db)['Agent']>;
  messagesForModel: Array<{ role: string; content: unknown }>;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
}): Promise<InternalGenerationResult> => {
  const result = await createGeneration({
    agentId: args.agent.publicId,
    messages: args.messagesForModel,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
  });

  if (result instanceof ReadableStream) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      'Unexpected streaming response'
    );
  }

  if (result.status === 'requires_action') {
    return {
      status: 'requires_action',
      generationId: result.id,
      traceId: result.traceId,
      requiredAction: result.requiredAction!,
    };
  }

  return {
    status: 'completed',
    generationId: result.id,
    traceId: result.traceId,
    content: result.output?.content ?? '',
    model: result.output?.model ?? '',
    output: result.output,
  };
};

const runGenerationForAgent = async (args: {
  generatingAgent: GenerationContext['generatingAgent'];
  messagesForModel: Array<{ role: string; content: unknown }>;
  model?: string;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
}): Promise<InternalGenerationResult> => {
  return runAgentGeneration({
    agent: args.generatingAgent,
    messagesForModel: args.messagesForModel,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
  });
};

const loadGenerationContext = async (args: {
  conversationId: string;
  agentId: string;
}): Promise<GenerationContext> => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
  }

  const generatingAgent = await db.Agent.findOne({
    where: { publicId: args.agentId, projectId: conversation.projectId },
  });

  if (!generatingAgent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Agent not found');
  }

  const maxContextMessages = (
    generatingAgent as unknown as { maxContextMessages: number | null }
  ).maxContextMessages;

  const allMessages = await db.ConversationMessage.findAll({
    where: { conversationId: conversation.id },
    include: [
      {
        model: db.Document,
        as: 'document',
        include: [{ model: db.File, as: 'file' }],
      },
      { model: db.Actor, as: 'actor' },
    ],
    order: [['position', 'ASC']],
  });

  const messages =
    maxContextMessages != null && allMessages.length > maxContextMessages
      ? allMessages.slice(-maxContextMessages)
      : allMessages;

  const snapshotPosition =
    messages.length > 0 ? messages[messages.length - 1].position : -1;

  return {
    conversation,
    generatingAgent,
    messages: messages as ConversationMessage[],
    snapshotPosition,
  };
};

const buildPersonaSystem = (agent: {
  instructions?: string | null;
  name?: string | null;
}) => {
  const lines = agent.instructions ? [agent.instructions] : [];
  lines.push(
    `You are ${
      agent.name ?? 'Assistant'
    }. Reply as this participant only — do not speak for any other actor.`
  );
  return lines.join('\n\n');
};

const firePostTurnSideEffects = (args: {
  conversationId: string;
  agentId: string;
  projectId: number;
  generationId: string;
  traceId: string;
  documentId: string;
  messagesForModel: Array<{ role: string; content: unknown }>;
  assistantContent: string;
}): void => {
  fireMemoryExtraction({
    agentId: args.agentId,
    projectIds: [args.projectId],
    generationId: args.generationId,
    messages: args.messagesForModel,
    assistantContent: args.assistantContent,
  });

  resolveProjectPublicId({ projectId: args.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'conversations.message.generated',
        projectId: args.projectId,
        projectPublicId,
        resourceType: 'conversation_message',
        resourceId: args.documentId,
        data: {
          conversationId: args.conversationId,
          agentId: args.agentId,
          generationId: args.generationId,
          traceId: args.traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );
};

export type GenerateConversationMessageResult =
  | {
      status: 'completed';
      content: string;
      message: Awaited<ReturnType<typeof addConversationMessage>>;
      generationId: string;
      traceId: string;
      model?: string;
    }
  | {
      status: 'requires_action';
      generationId: string;
      traceId: string;
      requiredAction: NonNullable<GenerationResult['requiredAction']>;
    };

export const generateConversationMessage = async (args: {
  conversationId: string;
  agentId: string;
  model?: string;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
}): Promise<GenerateConversationMessageResult> => {
  const ctx = await loadGenerationContext({
    conversationId: args.conversationId,
    agentId: args.agentId,
  });

  const { conversation, generatingAgent, messages, snapshotPosition } = ctx;

  const history = await buildConversationHistory({ messages });
  const personaSystem = buildPersonaSystem(generatingAgent);
  const messagesForModel: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: personaSystem },
    ...history,
  ];

  const genResult = await runGenerationForAgent({
    generatingAgent,
    messagesForModel,
    model: args.model,
    toolContext: args.toolContext,
    abortSignal: args.abortSignal,
  });

  if (genResult.status !== 'completed') {
    return genResult;
  }

  const {
    generationId,
    traceId,
    content: assistantContent,
    model: modelName,
  } = genResult;

  const responseMessages = genResult.output?.responseMessages;
  const persisted = await addConversationMessage({
    conversationId: args.conversationId,
    message: assistantContent,
    role: 'assistant',
    agentId: args.agentId,
    position: snapshotPosition + 1,
    metadata:
      responseMessages && responseMessages.length > 0
        ? { responseMessages }
        : undefined,
  });

  if (!persisted) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Conversation not found');
  }

  firePostTurnSideEffects({
    conversationId: args.conversationId,
    agentId: args.agentId,
    projectId: conversation.projectId as number,
    generationId,
    traceId,
    documentId: persisted.documentId,
    messagesForModel,
    assistantContent,
  });

  return {
    status: 'completed',
    content: assistantContent,
    message: persisted,
    generationId,
    traceId,
    model: modelName,
  };
};
