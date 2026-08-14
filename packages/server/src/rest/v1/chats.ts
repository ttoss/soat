import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { ChatMessage, ChatMessageInput, MappedChat } from 'src/lib/chats';
import {
  createChat,
  createChatCompletion,
  createChatCompletionForChat,
  deleteChat,
  findChat,
  getChat,
  listChats,
  streamChatCompletion,
  streamChatCompletionForChat,
} from 'src/lib/chats';
import { buildSrn } from 'src/lib/iam';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { assertNoSystemMessage } from './systemMessageGuard';

export const chatsRouter = new Router<Context>();

/** See `systemMessageGuard.ts` — system content travels only in `instructions`. */
const CHAT_SYSTEM_MESSAGE_REMEDY =
  'Send system content in the `instructions` field instead.';

/**
 * Checks whether the caller can perform `action` on `chat`.
 * Sets ctx.status = 403 and returns false when not allowed.
 */
const checkChatPermission = async (
  ctx: Context,
  chat: MappedChat,
  action: string
): Promise<boolean> => {
  const resource = buildSrn({
    projectPublicId: chat.project_id,
    resourceType: 'chat',
    resourceId: chat.id,
  });
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: chat.project_id,
    action,
    resource,
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  return allowed;
};

/**
 * Validates POST /chats request body
 */
const validateCreateChatBody = (
  body: unknown
):
  | {
      aiProviderId?: string;
      name?: string;
      instructions?: string;
      model?: string;
      projectId?: string;
      error?: undefined;
    }
  | { error: string } => {
  const {
    ai_provider_id: aiProviderId,
    name,
    instructions,
    model,
    project_id: projectId,
  } = body as Record<string, unknown>;

  // Optional since the model-routing project-default amendment: a chat that
  // pins no provider inherits the project's default_model_route_id, and
  // `createChat` rejects the combination the project cannot satisfy.
  if (aiProviderId !== undefined && typeof aiProviderId !== 'string') {
    return { error: 'ai_provider_id must be a string' };
  }

  return {
    aiProviderId,
    name: typeof name === 'string' ? name : undefined,
    instructions: typeof instructions === 'string' ? instructions : undefined,
    model: typeof model === 'string' ? model : undefined,
    projectId: typeof projectId === 'string' ? projectId : undefined,
  };
};

chatsRouter.post('/chats', async (ctx: Context) => {
  requireAuth(ctx);
  const validated = validateCreateChatBody(ctx.request.body);
  if (validated.error !== undefined) {
    throw new DomainError('VALIDATION_FAILED', validated.error);
  }

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: validated.projectId,
    action: 'chats:CreateChat',
    resourceType: 'chat',
  });
  const result = await createChat({
    projectId: Number(targetProjectId),
    aiProviderId: validated.aiProviderId,
    name: validated.name,
    instructions: validated.instructions,
    model: validated.model,
  });

  ctx.status = 201;
  ctx.body = result;
});

chatsRouter.get('/chats', async (ctx: Context) => {
  requireAuth(ctx);
  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'chats:ListChats',
    resourceType: 'chat',
  });

  ctx.body = await listChats({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

chatsRouter.get('/chats/:chat_id', async (ctx: Context) => {
  requireAuth(ctx);

  const { chat_id: chatId } = ctx.params;

  const chat = await getChat({ id: chatId });

  if (!(await checkChatPermission(ctx, chat, 'chats:GetChat'))) return;

  ctx.body = chat;
});

chatsRouter.delete('/chats/:chat_id', async (ctx: Context) => {
  requireAuth(ctx);

  const { chat_id: chatId } = ctx.params;

  const chat = await getChat({ id: chatId });

  if (!(await checkChatPermission(ctx, chat, 'chats:DeleteChat'))) return;

  await deleteChat({ id: chatId });

  ctx.status = 204;
});

/**
 * Handles streaming chat completion response
 */
const handleStreamingCompletion = async (args: {
  ctx: Context;
  chatId: string;
  messages: ChatMessageInput[];
  model?: string;
  instructions?: string;
}): Promise<void> => {
  args.ctx.respond = false;
  args.ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const textStream = await streamChatCompletionForChat({
      chatId: args.chatId,
      messages: args.messages,
      model: args.model,
      instructions: args.instructions,
      authUser: args.ctx.authUser!,
    });

    for await (const chunk of textStream) {
      args.ctx.res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
      );
    }

    args.ctx.res.write('data: [DONE]\n\n');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Internal server error';
    args.ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    args.ctx.res.end();
  }
};

chatsRouter.post('/chats/:chat_id/completions', async (ctx: Context) => {
  requireAuth(ctx);
  const { chat_id: chatId } = ctx.params;

  const { messages, model, stream, instructions } = ctx.request.body as {
    messages?: unknown;
    model?: string;
    stream?: boolean;
    instructions?: string;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'messages is required and must be a non-empty array'
    );
  }
  assertNoSystemMessage({ messages, remedy: CHAT_SYSTEM_MESSAGE_REMEDY });

  const chatMessages = (messages as Record<string, unknown>[]).map(
    (message): ChatMessageInput => {
      if (typeof message.document_id === 'string') {
        return {
          role: message.role as 'user' | 'assistant',
          documentId: message.document_id,
        };
      }
      return {
        role: message.role as 'user' | 'assistant',
        content: message.content as string,
      };
    }
  );

  // An unknown chatId is left to createChatCompletionForChat / the streaming
  // handler below, which already produce the established 400 / SSE-error
  // behavior for a missing chat. Only a chat that exists is permission-checked.
  const chat = await findChat({ id: chatId });
  if (
    chat &&
    !(await checkChatPermission(ctx, chat, 'chats:CreateChatCompletionForChat'))
  ) {
    return;
  }

  if (stream) {
    await handleStreamingCompletion({
      ctx,
      chatId,
      messages: chatMessages,
      model,
      instructions,
    });
    return;
  }

  const result = await createChatCompletionForChat({
    chatId,
    messages: chatMessages,
    model,
    instructions,
    authUser: ctx.authUser!,
  });

  ctx.body = {
    object: 'chat.completion',
    model: result.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: result.finishReason,
      },
    ],
  };
});

/**
 * Validates messages parameter
 */
const validateMessages = (messages: unknown): ChatMessage[] | null => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  return messages as ChatMessage[];
};

/**
 * Handles streaming stateless chat completion response
 */
const handleStatelessStreamingCompletion = async (args: {
  ctx: Context;
  aiProviderId: string;
  messages: ChatMessage[];
  model?: string;
  instructions?: string;
}): Promise<void> => {
  args.ctx.respond = false;
  args.ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const textStream = await streamChatCompletion({
      aiProviderId: args.aiProviderId,
      model: args.model,
      instructions: args.instructions,
      messages: args.messages,
    });

    for await (const chunk of textStream) {
      args.ctx.res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
      );
    }

    args.ctx.res.write('data: [DONE]\n\n');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Internal server error';
    args.ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    args.ctx.res.end();
  }
};

chatsRouter.post('/chat/completions', async (ctx: Context) => {
  requireAuth(ctx);
  const {
    ai_provider_id: aiProviderId,
    model,
    messages,
    stream,
    instructions,
  } = ctx.request.body as {
    ai_provider_id?: string;
    model?: string;
    messages?: unknown;
    stream?: boolean;
    instructions?: string;
  };

  const chatMessages = validateMessages(messages);
  if (!chatMessages) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'messages is required and must be a non-empty array'
    );
  }
  assertNoSystemMessage({ messages, remedy: CHAT_SYSTEM_MESSAGE_REMEDY });

  if (!aiProviderId || typeof aiProviderId !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'ai_provider_id is required');
  }

  if (stream) {
    await handleStatelessStreamingCompletion({
      ctx,
      aiProviderId,
      messages: chatMessages,
      model,
      instructions,
    });
    return;
  }

  try {
    const result = await createChatCompletion({
      aiProviderId,
      model,
      instructions,
      messages: chatMessages,
    });

    ctx.body = {
      object: 'chat.completion',
      model: result.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: result.finishReason,
        },
      ],
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'AI provider not found') {
      throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
    }

    throw error;
  }
});
