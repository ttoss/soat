import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { AiProviderSlug } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage } from 'ai';
import { generateText, streamText } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';
import { getDocument } from 'src/lib/documents';

import { db } from '../db';

const buildBedrockModel = (
  apiKey: string,
  config: Record<string, unknown> | undefined,
  model: string
): LanguageModel => {
  let parsedCredentials:
    | {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
      }
    | undefined;

  if (apiKey) {
    try {
      parsedCredentials = JSON.parse(apiKey);
    } catch {
      // fall back to default AWS credential chain
    }
  }

  const region = (config?.region as string | undefined) ?? 'us-east-1';

  return createAmazonBedrock({
    region,
    accessKeyId: parsedCredentials?.accessKeyId,
    secretAccessKey: parsedCredentials?.secretAccessKey,
    sessionToken: parsedCredentials?.sessionToken,
  })(model);
};

const isOpenAILikeProvider = (provider: AiProviderSlug): boolean => {
  return (
    provider === 'openai' || provider === 'gateway' || provider === 'custom'
  );
};

const getProviderFactory = (args: {
  provider: AiProviderSlug;
  apiKey: string;
  baseUrl: string | undefined;
  config: Record<string, unknown> | undefined;
}): ((model: string) => LanguageModel) | null => {
  const { provider, apiKey, baseUrl, config } = args;

  if (isOpenAILikeProvider(provider)) {
    return createOpenAI({ apiKey, baseURL: baseUrl });
  }
  if (provider === 'anthropic') {
    return createAnthropic({ apiKey, baseURL: baseUrl });
  }
  if (provider === 'google') {
    return createGoogleGenerativeAI({ apiKey });
  }
  if (provider === 'xai') {
    return createXai({ apiKey });
  }
  if (provider === 'groq') {
    return createGroq({ apiKey });
  }
  if (provider === 'azure') {
    const resourceName = (config?.resourceName as string | undefined) ?? '';
    return createAzure({ apiKey, resourceName });
  }
  if (provider === 'bedrock') {
    return (model: string) => {
      return buildBedrockModel(apiKey, config, model);
    };
  }
  return null;
};

const buildModel = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}): LanguageModel => {
  const { provider, secretValue, model, baseUrl, config } = args;
  const apiKey = secretValue ?? '';

  const factory = getProviderFactory({ provider, apiKey, baseUrl, config });
  if (factory) {
    return factory(model);
  }

  return createOpenAI({
    apiKey: 'ollama',
    baseURL: baseUrl ? `${baseUrl}/v1` : undefined,
  })(model);
};

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
}): Promise<MappedChat | 'ai_provider_not_found'> => {
  const aiProvider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId },
  });

  if (!aiProvider) {
    return 'ai_provider_not_found';
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

export const getChat = async (args: {
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

export const deleteChat = async (args: {
  id: string;
}): Promise<'deleted' | 'not_found'> => {
  const chat = await db.Chat.findOne({ where: { publicId: args.id } });

  if (!chat) {
    return 'not_found';
  }

  // Null out chatId on any actors linked to this chat before destroying.
  await db.Actor.update(
    { chatId: null },
    { where: { chatId: chat.id as number } }
  );

  await chat.destroy();
  return 'deleted';
};

const resolveMessages = async (
  messages: ChatMessageInput[]
): Promise<ChatMessage[]> => {
  const resolved: ChatMessage[] = [];

  for (const message of messages) {
    if ('documentId' in message) {
      const doc = await getDocument({ id: message.documentId });
      resolved.push({
        role: message.role,
        content: doc?.content ?? '',
      });
    } else {
      resolved.push(message);
    }
  }

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

  const result = await generateText({
    model,
    messages: args.messages as ModelMessage[],
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

  const result = streamText({
    model,
    messages: args.messages as ModelMessage[],
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
}): Promise<
  | { model: string; content: string; finishReason: string }
  | 'chat_not_found'
  | 'ai_provider_not_found'
> => {
  const chat = await db.Chat.findOne({
    where: { publicId: args.chatId },
    include: getChatIncludes(),
  });

  if (!chat) {
    return 'chat_not_found';
  }

  const typedChat = chat as unknown as Parameters<typeof mapChat>[0];

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedChat.aiProvider.publicId,
  });

  if (!resolved) {
    return 'ai_provider_not_found';
  }

  const resolvedMessages = await resolveMessages(args.messages);
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
    messages: finalMessages as ModelMessage[],
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
}) => {
  const chat = await db.Chat.findOne({
    where: { publicId: args.chatId },
    include: getChatIncludes(),
  });

  if (!chat) {
    return 'chat_not_found' as const;
  }

  const typedChat = chat as unknown as Parameters<typeof mapChat>[0];

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedChat.aiProvider.publicId,
  });

  if (!resolved) {
    return 'ai_provider_not_found' as const;
  }

  const resolvedMessages = await resolveMessages(args.messages);

  const systemFromRequest = resolvedMessages.find((m) => {
    return m.role === 'system';
  });
  const systemMessage = systemFromRequest?.content ?? typedChat.systemMessage;

  const userAssistantMessages = resolvedMessages.filter((m) => {
    return m.role !== 'system';
  });

  const finalMessages: ChatMessage[] = systemMessage
    ? [{ role: 'system', content: systemMessage }, ...userAssistantMessages]
    : userAssistantMessages;

  const model = buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.model ?? typedChat.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  const result = streamText({
    model,
    messages: finalMessages as ModelMessage[],
  });

  return result.textStream;
};
