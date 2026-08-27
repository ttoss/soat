import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { getAiProvider } from 'src/lib/aiProviders';
import type { ChatMessageInput, MappedChat } from 'src/lib/chats';
import {
  createChat,
  createChatCompletion,
  deleteChat,
  findChat,
  getChat,
  listChats,
  streamChatCompletion,
  validateChatCompletionTarget,
} from 'src/lib/chats';
import { buildSrn } from 'src/lib/iam';
import { toProviderDomainError } from 'src/lib/providerError';

import {
  parsePagination,
  type ProjectOwned,
  requireAuth,
  requireProjectAccess,
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
 * Authorizes a stateless completion.
 *
 * Such a call belongs to no chat, so it is checked against the AI provider's
 * own project — the only project it has. Until #998 this branch ran on
 * `requireAuth` alone: `chats:CreateChatCompletion` was declared in the
 * permission catalog and enforced for `chat_id`, but any authenticated
 * principal could complete against any provider it could name.
 *
 * The provider is loaded first so an unknown `ai_provider_id` keeps answering
 * `404`, as it did when the lib raised it after the (absent) permission check.
 */
const requireStatelessCompletionAccess = async (args: {
  ctx: Context;
  aiProviderId: string;
}): Promise<void> => {
  const provider: ProjectOwned | null = await getAiProvider({
    id: args.aiProviderId,
  });

  if (!provider) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
  }

  // Passing the `undefined` through would read as "no project named" and fall
  // back to the caller's entire scope — the #801 widening, where it would be
  // least visible.
  if (!provider.project_id) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  await requireProjectAccess({
    ctx: args.ctx,
    projectPublicId: provider.project_id,
    action: 'chats:CreateChatCompletion',
    resourceType: 'chat',
  });
};

/**
 * Parses the wire `messages` array into lib inputs, expanding the `document_id`
 * form into the internal `documentId` one.
 */
const parseChatMessages = (messages: unknown): ChatMessageInput[] => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'messages is required and must be a non-empty array'
    );
  }
  assertNoSystemMessage({ messages, remedy: CHAT_SYSTEM_MESSAGE_REMEDY });

  return (messages as Record<string, unknown>[]).map(
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
};

/**
 * Handles streaming chat completion response
 */
const handleStreamingCompletion = async (args: {
  ctx: Context;
  aiProviderId?: string;
  chatId?: string;
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
    const textStream = await streamChatCompletion({
      aiProviderId: args.aiProviderId,
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
    // Headers went out with the `200` before the provider was called, so an
    // upstream rejection can never become a status code — the terminal SSE
    // event is the only place left to report it (#1081).
    const mapped = toProviderDomainError(error) ?? error;
    const message =
      mapped instanceof Error ? mapped.message : 'Internal server error';
    args.ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    args.ctx.res.end();
  }
};

chatsRouter.post('/chat/completions', async (ctx: Context) => {
  requireAuth(ctx);
  const {
    ai_provider_id: aiProviderId,
    chat_id: chatId,
    model,
    messages,
    stream,
    instructions,
  } = ctx.request.body as {
    ai_provider_id?: string;
    chat_id?: string;
    model?: string;
    messages?: unknown;
    stream?: boolean;
    instructions?: string;
  };

  const chatMessages = parseChatMessages(messages);

  const targetError = validateChatCompletionTarget({ aiProviderId, chatId });
  if (targetError) {
    throw new DomainError('VALIDATION_FAILED', targetError);
  }

  // Both targets are gated on the same action, each against the project the
  // call belongs to.
  if (chatId) {
    // An unknown chat_id is left to the lib, which already produces the
    // established 400 / SSE-error behavior for a missing chat. Only a chat that
    // exists is permission-checked.
    const chat = await findChat({ id: chatId });
    if (
      chat &&
      !(await checkChatPermission(ctx, chat, 'chats:CreateChatCompletion'))
    ) {
      return;
    }
  } else {
    await requireStatelessCompletionAccess({
      ctx,
      aiProviderId: aiProviderId as string,
    });
  }

  if (stream) {
    await handleStreamingCompletion({
      ctx,
      aiProviderId,
      chatId,
      messages: chatMessages,
      model,
      instructions,
    });
    return;
  }

  try {
    const result = await createChatCompletion({
      aiProviderId,
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
  } catch (error) {
    if (error instanceof Error && error.message === 'AI provider not found') {
      throw new DomainError('RESOURCE_NOT_FOUND', 'AI provider not found');
    }

    // Without this an upstream rejection came back as a bare
    // `500 INTERNAL_ERROR`, indistinguishable from a fault in SOAT itself
    // (#1081). Non-provider errors map to `null` and rethrow untouched.
    throw toProviderDomainError(error) ?? error;
  }
});
