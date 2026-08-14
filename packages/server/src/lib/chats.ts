import type { ModelMessage } from 'ai';
import { generateText, streamText } from 'ai';
import type { AuthUser } from 'src/Context';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  buildResolvedChatModel,
  buildRoutedChatModel,
  meterChatCompletion,
  resolveChatModel,
  type ResolvedChatModel,
} from './chatCompletionModel';
import { resolveMessageContent } from './messageContent';
import type { ResourceIncludes } from './modelIncludes';
import {
  assertModelBindingResolvable,
  resolveConsumerModelRoute,
  routedMaxRetries,
  validateModelRouteExclusivity,
} from './modelRoutes';
import { paginatedList, type PaginatedResult } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

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
  project_id: string;
  ai_provider_id: string | null;
  name: string | null;
  system_message: string | null;
  model: string | null;
  created_at: Date;
  updated_at: Date;
};

type ChatRow = InstanceType<typeof db.Chat> & {
  aiProvider: InstanceType<typeof db.AiProvider> | null;
  project: InstanceType<typeof db.Project>;
};

const mapChat = (chat: ChatRow): MappedChat => {
  return {
    id: chat.publicId,
    project_id: chat.project.publicId,
    // Null when the chat pins no provider and inherits the project default route.
    ai_provider_id: chat.aiProvider?.publicId ?? null,
    name: chat.name,
    system_message: chat.systemMessage,
    model: chat.model,
    created_at: chat.createdAt,
    updated_at: chat.updatedAt,
  };
};

const getChatIncludes = (): ResourceIncludes => {
  return [
    { model: db.AiProvider, as: 'aiProvider' },
    { model: db.Project, as: 'project' },
  ];
};

const chats = makeResourceAccessor<ChatRow>({
  model: () => {
    return db.Chat;
  },
  includes: getChatIncludes,
  label: 'Chat',
});

export const createChat = async (args: {
  projectId: number;
  aiProviderId?: string;
  name?: string;
  systemMessage?: string;
  model?: string;
}): Promise<MappedChat> => {
  // At most one binding: a chat that pins no provider inherits its project's
  // `default_model_route_id`, which must therefore exist. `model` cannot
  // accompany the inherited route — each target names its own.
  const bindingError = validateModelRouteExclusivity({
    modelRouteId: null,
    aiProviderId: args.aiProviderId,
    model: args.model,
  });
  if (bindingError) {
    throw new DomainError('VALIDATION_FAILED', bindingError);
  }
  await assertModelBindingResolvable({
    projectId: args.projectId,
    aiProviderId: args.aiProviderId,
    modelRouteId: null,
    resourceLabel: 'chat',
  });

  const aiProvider = args.aiProviderId
    ? await db.AiProvider.findOne({ where: { publicId: args.aiProviderId } })
    : null;

  if (args.aiProviderId && !aiProvider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found.`
    );
  }

  const chat = await db.Chat.create({
    projectId: args.projectId,
    aiProviderId: aiProvider ? aiProvider.id : null,
    name: args.name ?? null,
    systemMessage: args.systemMessage ?? null,
    model: args.model ?? null,
  });

  return mapChat(await chats.reload(chat));
};

export const findChat = async (args: {
  id: string;
}): Promise<MappedChat | null> => {
  const chat = await chats.findByPublicId({ id: args.id });
  return chat ? mapChat(chat) : null;
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
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedChat>> => {
  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Chat.findAndCountAll({
        where: { projectId: args.projectIds },
        include: getChatIncludes(),
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (chat) => {
      return mapChat(chat as ChatRow);
    },
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
            ? { type: 'document' as const, document_id: message.documentId }
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

/**
 * The model a chat-scoped completion runs on, following the chat's own binding:
 * its pinned provider, else its project's `default_model_route_id`. Shared by
 * the streaming and non-streaming paths so both resolve and meter identically.
 */
const resolveChatScopedModel = async (args: {
  typedChat: Parameters<typeof mapChat>[0];
  model?: string;
}): Promise<ResolvedChatModel> => {
  const { typedChat } = args;
  const projectId = typedChat.projectId as number;

  const route = await resolveConsumerModelRoute({
    projectId,
    aiProviderId: typedChat.aiProvider?.publicId,
  });
  if (route) {
    return buildRoutedChatModel({ projectId, route });
  }

  const resolved = typedChat.aiProvider
    ? await resolveAiProviderSecret({
        aiProviderId: typedChat.aiProvider.publicId,
      })
    : null;

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      'AI provider not found or not configured.'
    );
  }

  return buildResolvedChatModel({
    resolved,
    modelName: args.model ?? typedChat.model ?? resolved.defaultModel,
  });
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

/**
 * A completion names exactly one target: an AI provider directly, or a stored
 * chat that supplies the provider, model and system message. Shared by the REST
 * handler and any other caller so both reject the same combinations.
 */
export const validateChatCompletionTarget = (args: {
  aiProviderId?: unknown;
  chatId?: unknown;
}): string | null => {
  if (args.aiProviderId && args.chatId) {
    return 'ai_provider_id and chat_id are mutually exclusive';
  }
  if (!args.aiProviderId && !args.chatId) {
    return 'ai_provider_id or chat_id is required';
  }
  return null;
};

type ChatCompletionArgs = {
  aiProviderId?: string;
  chatId?: string;
  messages: ChatMessageInput[];
  model?: string;
  authUser: AuthUser;
};

/**
 * Everything a completion needs before the provider call, resolved the same way
 * for both targets: the chat (when one is named), the messages with any
 * `documentId` references expanded, the effective system message, and the model.
 */
const prepareChatCompletion = async (args: ChatCompletionArgs) => {
  const targetError = validateChatCompletionTarget({
    aiProviderId: args.aiProviderId,
    chatId: args.chatId,
  });
  if (targetError) {
    throw new DomainError('VALIDATION_FAILED', targetError);
  }

  const typedChat = args.chatId
    ? await chats.getByPublicId({
        id: args.chatId,
        errorCode: 'CHAT_NOT_FOUND',
      })
    : null;

  const resolvedMessages = await resolveMessages({
    messages: args.messages,
    authUser: args.authUser,
  });

  // A system message in the request overrides the chat's stored one for this
  // call only; a stateless completion has nothing to fall back to.
  const systemMessage = getChatSystemMessage(
    resolvedMessages,
    typedChat?.systemMessage ?? null
  );

  const resolvedModel = typedChat
    ? await resolveChatScopedModel({ typedChat, model: args.model })
    : await resolveChatModel({
        // No chat means `validateChatCompletionTarget` above accepted an
        // `aiProviderId`, which TypeScript cannot infer from that check.
        aiProviderId: args.aiProviderId as string,
        model: args.model,
      });

  return {
    fallbackModel: args.model ?? typedChat?.model ?? undefined,
    messages: resolvedMessages.filter((m) => {
      return m.role !== 'system';
    }) as ModelMessage[],
    resolvedModel,
    systemMessage,
  };
};

export const createChatCompletion = async (
  args: ChatCompletionArgs
): Promise<{ model: string; content: string; finishReason: string }> => {
  const { fallbackModel, messages, resolvedModel, systemMessage } =
    await prepareChatCompletion(args);

  const result = await generateText({
    model: resolvedModel.model,
    instructions: systemMessage ?? undefined,
    messages,
    // A routed model owns every attempt itself (see `routedMaxRetries`).
    maxRetries: routedMaxRetries(resolvedModel.model),
  });

  const model = result.response?.modelId ?? fallbackModel ?? '';
  meterChatCompletion({ resolved: resolvedModel, model, usage: result.usage });

  return {
    model,
    content: result.text,
    finishReason: result.finishReason,
  };
};

export const streamChatCompletion = async (args: ChatCompletionArgs) => {
  const { fallbackModel, messages, resolvedModel, systemMessage } =
    await prepareChatCompletion(args);

  const result = streamText({
    model: resolvedModel.model,
    instructions: systemMessage ?? undefined,
    messages,
    maxRetries: routedMaxRetries(resolvedModel.model),
    // Token counts only arrive once the provider closes the stream, so a
    // streamed completion meters at the end rather than up front. A stream the
    // client abandons never reaches `onEnd` and is not metered.
    onEnd: ({ usage }) => {
      meterChatCompletion({
        resolved: resolvedModel,
        model: fallbackModel,
        usage,
      });
    },
  });

  return result.textStream;
};
