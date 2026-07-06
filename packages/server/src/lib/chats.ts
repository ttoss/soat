import type { LanguageModel, ModelMessage } from 'ai';
import { generateText, streamText } from 'ai';
import type { AuthUser } from 'src/Context';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import { buildModel } from './agentModel';
import { resolveMessageContent } from './messageContent';

const resolveModel = async (args: {
  aiProviderId: string;
  model?: string;
}): Promise<LanguageModel> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.aiProviderId,
  });

  if (!resolved) {
    throw new Error('AI provider not found');
  }

  return buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });
};

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ChatMessageInput =
  | {
      role: 'user' | 'assistant' | 'system';
      content: string;
    }
  | {
      role: 'user' | 'assistant';
      documentId: string;
    };

export type MappedChat = {
  id: string;
  projectId: string;
  aiProviderId: string;
  name: string | null;
  systemMessage: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const mapChat = (
  chat: InstanceType<typeof db.Chat> & {
    aiProvider: InstanceType<typeof db.AiProvider>;
    project: InstanceType<typeof db.Project>;
  }
): MappedChat => {
  return {
    id: chat.publicId,
    projectId: chat.project.publicId,
    aiProviderId: chat.aiProvider.publicId,
    name: chat.name,
    systemMessage: chat.systemMessage,
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
};

const getChatIncludes = () => {
  return [
    { model: db.AiProvider, as: 'aiProvider' },
    { model: db.Project, as: 'project' },
  ];
};

export const createChat = async (args: {
  projectId: number;
  aiProviderId: string;
  name?: string;
  systemMessage?: string;
  model?: string;
}): Promise<MappedChat> => {
  const aiProvider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId },
  });

  if (!aiProvider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found.`
    );
  }

  const chat = await db.Chat.create({
    projectId: args.projectId,
    aiProviderId: aiProvider.id,
    name: args.name ?? null,
    systemMessage: args.systemMessage ?? null,
    model: args.model ?? null,
  });

  const created = await db.Chat.findOne({
    where: { id: (chat as unknown as { id: number }).id },
    include: getChatIncludes(),
  });

  return mapChat(created as unknown as Parameters<typeof mapChat>[0]);
};

export const findChat = async (args: {
  id: string;
}): Promise<MappedChat | null> => {
  const chat = await db.Chat.findOne({
    where: { publicId: args.id },
    include: getChatIncludes(),
  });

  if (!chat) {
    return null;
  }

  return mapChat(chat as unknown as Parameters<typeof mapChat>[0]);
};

export const getChat = async (args: { id: string }): Promise<MappedChat> => {
  const chat = await findChat(args);

  if (!chat) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Chat '${args.id}' not found.`);
  }

  return chat;
};

export const listChats = async (args: {
  projectIds: number[];
}): Promise<MappedChat[]> => {
  const chats = await db.Chat.findAll({
    where: { projectId: args.projectIds },
    include: getChatIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return chats.map((chat) => {
    return mapChat(chat as unknown as Parameters<typeof mapChat>[0]);
  });
};

export const deleteChat = async (args: { id: string }): Promise<void> => {
  const chat = await db.Chat.findOne({ where: { publicId: args.id } });

  if (!chat) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Chat '${args.id}' not found.`);
  }

  // Null out chatId on any actors linked to this chat before destroying.
  await db.Actor.update(
    { chatId: null },
    { where: { chatId: chat.id as number } }
  );

  await chat.destroy();
};

const resolveMessages = async (args: {
  messages: ChatMessageInput[];
  authUser: AuthUser;
}): Promise<ChatMessage[]> => {
  const resolved = await Promise.all(
    args.messages.map(async (message) => {
      const resolvedContent = await resolveMessageContent({
        content:
          'documentId' in message
            ? { type: 'document' as const, documentId: message.documentId }
            : message.content,
        authUser: args.authUser,
      });

      return {
        role: message.role,
        content: resolvedContent.content,
      };
    })
  );

  return resolved;
};

export const createChatCompletion = async (args: {
  aiProviderId: string;
  model?: string;
  messages: ChatMessage[];
}) => {
  const model = await resolveModel({
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  const system = args.messages.find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = args.messages.filter((m) => {
    return m.role !== 'system';
  });

  const result = await generateText({
    model,
    instructions: system,
    messages: nonSystemMessages as ModelMessage[],
  });

  return {
    model: result.response?.modelId ?? args.model ?? '',
    content: result.text,
    finishReason: result.finishReason,
  };
};

export const streamChatCompletion = async (args: {
  aiProviderId: string;
  model?: string;
  messages: ChatMessage[];
}) => {
  const model = await resolveModel({
    aiProviderId: args.aiProviderId,
    model: args.model,
  });

  const system = args.messages.find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = args.messages.filter((m) => {
    return m.role !== 'system';
  });

  const result = streamText({
    model,
    instructions: system,
    messages: nonSystemMessages as ModelMessage[],
  });

  return result.textStream;
};

const buildChatFinalMessages = (
  resolvedMessages: ChatMessage[],
  systemMessage: string | null
): ChatMessage[] => {
  const userAssistantMessages = resolvedMessages.filter((m) => {
    return m.role !== 'system';
  });

  return systemMessage
    ? [{ role: 'system', content: systemMessage }, ...userAssistantMessages]
    : userAssistantMessages;
};

const getChatSystemMessage = (
  resolvedMessages: ChatMessage[],
  defaultSystemMessage: string | null
): string | null => {
  const systemFromRequest = resolvedMessages.find((m) => {
    return m.role === 'system';
  });
  return systemFromRequest?.content ?? defaultSystemMessage;
};

export const createChatCompletionForChat = async (args: {
  chatId: string;
  messages: ChatMessageInput[];
  model?: string;
  authUser: AuthUser;
}): Promise<{ model: string; content: string; finishReason: string }> => {
  const chat = await db.Chat.findOne({
    where: { publicId: args.chatId },
    include: getChatIncludes(),
  });

  if (!chat) {
    throw new DomainError('CHAT_NOT_FOUND', `Chat '${args.chatId}' not found.`);
  }

  const typedChat = chat as unknown as Parameters<typeof mapChat>[0];

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedChat.aiProvider.publicId,
  });

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      'AI provider not found or not configured.'
    );
  }

  const resolvedMessages = await resolveMessages({
    messages: args.messages,
    authUser: args.authUser,
  });
  const systemMessage = getChatSystemMessage(
    resolvedMessages,
    typedChat.systemMessage
  );
  const finalMessages = buildChatFinalMessages(resolvedMessages, systemMessage);

  const model = buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.model ?? typedChat.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  const result = await generateText({
    model,
    instructions: systemMessage ?? undefined,
    messages: finalMessages.filter((m) => {
      return m.role !== 'system';
    }) as ModelMessage[],
  });

  return {
    model: result.response?.modelId ?? args.model ?? typedChat.model ?? '',
    content: result.text,
    finishReason: result.finishReason,
  };
};

export const streamChatCompletionForChat = async (args: {
  chatId: string;
  messages: ChatMessageInput[];
  model?: string;
  authUser: AuthUser;
}) => {
  const chat = await db.Chat.findOne({
    where: { publicId: args.chatId },
    include: getChatIncludes(),
  });

  if (!chat) {
    throw new DomainError('CHAT_NOT_FOUND', `Chat '${args.chatId}' not found.`);
  }

  const typedChat = chat as unknown as Parameters<typeof mapChat>[0];

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedChat.aiProvider.publicId,
  });

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      'AI provider not found or not configured.'
    );
  }

  const resolvedMessages = await resolveMessages({
    messages: args.messages,
    authUser: args.authUser,
  });

  const systemFromRequest = resolvedMessages.find((m) => {
    return m.role === 'system';
  });
  const systemMessage = systemFromRequest?.content ?? typedChat.systemMessage;

  const userAssistantMessages = resolvedMessages.filter((m) => {
    return m.role !== 'system';
  });

  const model = buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.model ?? typedChat.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  const result = streamText({
    model,
    instructions: systemMessage ?? undefined,
    messages: userAssistantMessages as ModelMessage[],
  });

  return result.textStream;
};
