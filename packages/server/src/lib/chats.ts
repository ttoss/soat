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
import { db } from '../db';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';
import { getDocument } from 'src/lib/documents';

const buildModel = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}): LanguageModel => {
  const { provider, secretValue, model, baseUrl, config } = args;
  const apiKey = secretValue ?? '';

  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL: baseUrl })(model);

    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: baseUrl })(model);

    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);

    case 'xai':
      return createXai({ apiKey })(model);

    case 'groq':
      return createGroq({ apiKey })(model);

    case 'azure': {
      const resourceName = (config?.resourceName as string | undefined) ?? '';
      return createAzure({ apiKey, resourceName })(model);
    }

    case 'bedrock': {
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
    }

    case 'ollama':
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: baseUrl ? `${baseUrl}/v1` : undefined,
      })(model);

    case 'gateway':
    case 'custom':
      return createOpenAI({ apiKey, baseURL: baseUrl })(model);
  }
};

const resolveModel = async (args: {
  aiProviderId?: string;
  model?: string;
}): Promise<LanguageModel> => {
  if (args.aiProviderId) {
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
  }

  const fallbackModel = args.model ?? process.env.CHAT_MODEL ?? 'qwen2.5:0.5b';
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

  return createOpenAI({ apiKey: 'ollama', baseURL: `${ollamaBaseUrl}/v1` })(
    fallbackModel
  );
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
): MappedChat => ({
  id: chat.publicId,
  projectId: chat.project.publicId,
  aiProviderId: chat.aiProvider.publicId,
  name: chat.name,
  systemMessage: chat.systemMessage,
  model: chat.model,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

const getChatIncludes = () => [
  { model: db.AiProvider, as: 'aiProvider' },
  { model: db.Project, as: 'project' },
];

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

  return chats.map((chat) =>
    mapChat(chat as unknown as Parameters<typeof mapChat>[0])
  );
};

export const deleteChat = async (args: {
  id: string;
}): Promise<'deleted' | 'not_found'> => {
  const chat = await db.Chat.findOne({ where: { publicId: args.id } });

  if (!chat) {
    return 'not_found';
  }

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
  aiProviderId?: string;
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
  aiProviderId?: string;
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

  const systemFromRequest = resolvedMessages.find((m) => m.role === 'system');
  const systemMessage = systemFromRequest?.content ?? typedChat.systemMessage;

  const userAssistantMessages = resolvedMessages.filter(
    (m) => m.role !== 'system'
  );

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

  const systemFromRequest = resolvedMessages.find((m) => m.role === 'system');
  const systemMessage = systemFromRequest?.content ?? typedChat.systemMessage;

  const userAssistantMessages = resolvedMessages.filter(
    (m) => m.role !== 'system'
  );

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
