import fs from 'node:fs';

import { db } from '../db';
import { createGeneration, type GenerationResult } from './agents';
import { createChatCompletionForChat } from './chats';
import { addConversationMessage } from './conversationMessages';
import { emitEvent, resolveProjectPublicId } from './eventBus';

type ConversationMessage = InstanceType<(typeof db)['ConversationMessage']> & {
  document?: InstanceType<(typeof db)['Document']> & {
    file?: InstanceType<(typeof db)['File']>;
  };
  actor?: InstanceType<(typeof db)['Actor']>;
};

type GenerationContext = {
  conversation: InstanceType<(typeof db)['Conversation']>;
  generatingActor: InstanceType<(typeof db)['Actor']> & {
    agent?: InstanceType<(typeof db)['Agent']>;
    chat?: InstanceType<(typeof db)['Chat']>;
  };
  messages: Array<ConversationMessage>;
  snapshotPosition: number;
};

const readMessageContent = (msg: ConversationMessage): string => {
  const storagePath = msg.document?.file?.storagePath;
  if (!storagePath) {
    return '';
  }
  try {
    if (fs.existsSync(storagePath)) {
      return fs.readFileSync(storagePath, 'utf-8');
    }
  } catch {
    // Ignore read errors
  }
  return '';
};

const buildMessageEntry = (args: {
  msg: ConversationMessage;
  generatingActorId: number;
}): { role: string; content: string } => {
  const content = readMessageContent(args.msg);
  if (args.msg.actorId === args.generatingActorId) {
    return { role: 'assistant', content };
  }
  const speakerName = args.msg.actor?.name ?? 'participant';
  const meta = (args.msg as { metadata?: Record<string, unknown> | null })
    .metadata;
  const metadataStr =
    meta && Object.keys(meta).length > 0
      ? ` [${Object.entries(meta)
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

const buildConversationHistory = (args: {
  messages: Array<ConversationMessage>;
  generatingActorId: number;
}) => {
  return args.messages.map((msg) => {
    return buildMessageEntry({
      msg,
      generatingActorId: args.generatingActorId,
    });
  });
};

type InternalGenerationResult =
  | {
      status: 'completed';
      generationId: string;
      traceId: string;
      content: string;
      model: string;
    }
  | {
      status: 'requires_action';
      generationId: string;
      traceId: string;
      requiredAction: NonNullable<GenerationResult['requiredAction']>;
    }
  | 'agent_or_chat_not_found'
  | 'ai_provider_not_found';

const runAgentGeneration = async (args: {
  agent: InstanceType<(typeof db)['Agent']>;
  messagesForModel: Array<{ role: string; content: string }>;
  toolContext?: Record<string, string>;
}): Promise<InternalGenerationResult> => {
  const result = await createGeneration({
    agentId: args.agent.publicId,
    messages: args.messagesForModel,
    toolContext: args.toolContext,
  });

  if (result === 'not_found' || result instanceof ReadableStream) {
    return 'agent_or_chat_not_found';
  }

  if (result === 'ai_provider_not_found') {
    return 'ai_provider_not_found';
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
  };
};

const runChatGeneration = async (args: {
  chat: InstanceType<(typeof db)['Chat']>;
  messagesForModel: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  model?: string;
}): Promise<InternalGenerationResult> => {
  const result = await createChatCompletionForChat({
    chatId: args.chat.publicId,
    messages: args.messagesForModel,
    model: args.model,
  });

  if (result === 'chat_not_found') {
    return 'agent_or_chat_not_found';
  }

  if (result === 'ai_provider_not_found') {
    return 'ai_provider_not_found';
  }

  return {
    status: 'completed',
    generationId: '',
    traceId: '',
    content: result.content,
    model: result.model,
  };
};

const runGenerationForActor = async (args: {
  generatingActor: GenerationContext['generatingActor'];
  messagesForModel: Array<{ role: string; content: string }>;
  model?: string;
  toolContext?: Record<string, string>;
}): Promise<
  | InternalGenerationResult
  | 'actor_missing_agent_or_chat'
  | 'agent_or_chat_not_found'
> => {
  if (args.generatingActor.agentId) {
    if (!args.generatingActor.agent) {
      return 'agent_or_chat_not_found';
    }
    return runAgentGeneration({
      agent: args.generatingActor.agent,
      messagesForModel: args.messagesForModel,
      toolContext: args.toolContext,
    });
  } else if (args.generatingActor.chatId) {
    if (!args.generatingActor.chat) {
      return 'agent_or_chat_not_found';
    }
    return runChatGeneration({
      chat: args.generatingActor.chat,
      messagesForModel: args.messagesForModel as Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }>,
      model: args.model,
    });
  }
  return 'actor_missing_agent_or_chat';
};

const loadGenerationContext = async (args: {
  conversationId: string;
  actorId: string;
}): Promise<
  GenerationContext | 'conversation_not_found' | 'actor_not_found'
> => {
  const conversation = await db.Conversation.findOne({
    where: { publicId: args.conversationId },
  });

  if (!conversation) {
    return 'conversation_not_found';
  }

  const generatingActor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: conversation.projectId },
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Chat, as: 'chat' },
    ],
  });

  if (!generatingActor) {
    return 'actor_not_found';
  }

  const messages = await db.ConversationMessage.findAll({
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

  const snapshotPosition =
    messages.length > 0 ? messages[messages.length - 1].position : -1;

  return {
    conversation,
    generatingActor: generatingActor as GenerationContext['generatingActor'],
    messages: messages as ConversationMessage[],
    snapshotPosition,
  };
};

const buildPersonaSystem = (actor: {
  instructions?: string | null;
  name: string;
}) => {
  const lines = actor.instructions ? [actor.instructions] : [];
  lines.push(
    `You are ${actor.name}. Reply as this participant only — do not speak for any other actor.`
  );
  return lines.join('\n\n');
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
    }
  | 'conversation_not_found'
  | 'actor_not_found'
  | 'actor_missing_agent_or_chat'
  | 'ai_provider_not_found'
  | 'agent_or_chat_not_found';

export const generateConversationMessage = async (args: {
  conversationId: string;
  actorId: string;
  model?: string;
  toolContext?: Record<string, string>;
}): Promise<GenerateConversationMessageResult> => {
  const ctx = await loadGenerationContext({
    conversationId: args.conversationId,
    actorId: args.actorId,
  });

  if (typeof ctx === 'string') {
    return ctx;
  }

  const { conversation, generatingActor, messages, snapshotPosition } = ctx;

  const history = buildConversationHistory({
    messages,
    generatingActorId: generatingActor.id,
  });

  const personaSystem = buildPersonaSystem(generatingActor);
  const messagesForModel = [
    { role: 'system', content: personaSystem },
    ...history,
  ];

  const genResult = await runGenerationForActor({
    generatingActor,
    messagesForModel,
    model: args.model,
    toolContext: args.toolContext,
  });

  if (typeof genResult === 'string') {
    return genResult;
  }

  if (genResult.status !== 'completed') {
    return genResult;
  }

  const {
    generationId,
    traceId,
    content: assistantContent,
    model: modelName,
  } = genResult;

  const persisted = await addConversationMessage({
    conversationId: args.conversationId,
    message: assistantContent,
    actorId: args.actorId,
    position: snapshotPosition + 1,
  });

  if (!persisted) {
    return 'conversation_not_found';
  }

  resolveProjectPublicId({ projectId: conversation.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'conversations.message.generated',
        projectId: conversation.projectId,
        projectPublicId,
        resourceType: 'conversation_message',
        resourceId: persisted.documentId,
        data: {
          conversationId: args.conversationId,
          actorId: args.actorId,
          generationId,
          traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return {
    status: 'completed',
    content: assistantContent,
    message: persisted,
    generationId,
    traceId,
    model: modelName,
  };
};
