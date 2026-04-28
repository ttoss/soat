import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { createActor } from 'src/lib/actors';
import type { ChatMessage, ChatMessageInput } from 'src/lib/chats';
import {
  createChat,
  createChatCompletion,
  createChatCompletionForChat,
  deleteChat,
  getChat,
  listChats,
  streamChatCompletion,
  streamChatCompletionForChat,
} from 'src/lib/chats';

import {
  checkAuth,
  checkProjectId,
  getTargetProjectId,
  resolveProjectIdsWithAction,
} from './helpers';

export const chatsRouter = new Router<Context>();

/**
 * Validates POST /chats request body
 */
const validateCreateChatBody = (
  body: unknown
):
  | {
      aiProviderId: string;
      name?: string;
      systemMessage?: string;
      model?: string;
      projectId?: string;
      error?: undefined;
    }
  | { error: string; aiProviderId?: undefined } => {
  const { aiProviderId, name, systemMessage, model, projectId } =
    body as Record<string, unknown>;

  if (!aiProviderId || typeof aiProviderId !== 'string') {
    return { error: 'aiProviderId is required' };
  }

  return {
    aiProviderId,
    name: typeof name === 'string' ? name : undefined,
    systemMessage:
      typeof systemMessage === 'string' ? systemMessage : undefined,
    model: typeof model === 'string' ? model : undefined,
    projectId: typeof projectId === 'string' ? projectId : undefined,
  };
};

chatsRouter.post('/chats', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const validated = validateCreateChatBody(ctx.request.body);
  if (validated.error !== undefined) {
    ctx.status = 400;
    ctx.body = { error: validated.error };
    return;
  }

  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId: validated.projectId,
    action: 'chats:CreateChat',
  });

  if (projectIds === null) return;

  const targetProjectId = getTargetProjectId({
    projectIds,
    apiKeyProjectId: ctx.authUser?.apiKeyProjectId,
  });

  if (!checkProjectId({ ctx, projectId: targetProjectId })) return;

  const result = await createChat({
    projectId: Number(targetProjectId),
    aiProviderId: validated.aiProviderId,
    name: validated.name,
    systemMessage: validated.systemMessage,
    model: validated.model,
  });

  if (result === 'ai_provider_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

chatsRouter.get('/chats', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'chats:ListChats',
  });

  if (projectIds === null) return;

  ctx.body = await listChats({ projectIds: projectIds ?? [] });
});

chatsRouter.get('/chats/:chat_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { chat_id: chatId } = ctx.params;

  const chat = await getChat({ id: chatId });

  if (!chat) {
    ctx.status = 404;
    ctx.body = { error: 'Chat not found' };
    return;
  }

  ctx.body = chat;
});

chatsRouter.delete('/chats/:chat_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { chat_id: chatId } = ctx.params;

  const result = await deleteChat({ id: chatId });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Chat not found' };
    return;
  }

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
    });

    if (typeof textStream === 'string') {
      args.ctx.res.write(`data: ${JSON.stringify({ error: textStream })}\n\n`);
      args.ctx.res.end();
      return;
    }

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
  if (!checkAuth(ctx)) return;

  const { chat_id: chatId } = ctx.params;

  const { messages, model, stream } = ctx.request.body as {
    messages?: unknown;
    model?: string;
    stream?: boolean;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'messages is required and must be a non-empty array' };
    return;
  }

  const chatMessages = messages as ChatMessageInput[];

  if (stream) {
    await handleStreamingCompletion({
      ctx,
      chatId,
      messages: chatMessages,
      model,
    });
    return;
  }

  const result = await createChatCompletionForChat({
    chatId,
    messages: chatMessages,
    model,
  });

  if (result === 'chat_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Chat not found' };
    return;
  }

  if (result === 'ai_provider_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

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

chatsRouter.post('/chats/completions', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const { aiProviderId, model, messages, stream } = ctx.request.body as {
    aiProviderId?: string;
    model?: string;
    messages?: unknown;
    stream?: boolean;
  };

  const chatMessages = validateMessages(messages);
  if (!chatMessages) {
    ctx.status = 400;
    ctx.body = { error: 'messages is required and must be a non-empty array' };
    return;
  }

  if (stream) {
    ctx.respond = false;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const textStream = await streamChatCompletion({
        aiProviderId,
        model,
        messages: chatMessages,
      });

      for await (const chunk of textStream) {
        ctx.res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
        );
      }

      ctx.res.write('data: [DONE]\n\n');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal server error';
      ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      ctx.res.end();
    }

    return;
  }

  try {
    const result = await createChatCompletion({
      aiProviderId,
      model,
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
      ctx.status = 404;
      ctx.body = { error: 'AI provider not found' };
      return;
    }

    throw error;
  }
});

chatsRouter.post('/chats/:chat_id/actors', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const chat = await db.Chat.findOne({
    where: { publicId: ctx.params.chat_id },
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!chat) {
    ctx.status = 404;
    ctx.body = { error: 'Chat not found' };
    return;
  }

  const project = (
    chat as unknown as {
      project?: InstanceType<(typeof db)['Project']>;
    }
  ).project;

  if (!project?.publicId) {
    ctx.status = 404;
    ctx.body = { error: 'Chat project not found' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: project.publicId,
    action: 'actors:CreateActor',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name: string;
    type?: string;
    externalId?: string;
    instructions?: string | null;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const actor = await createActor({
    projectId: chat.projectId,
    name: body.name,
    type: body.type,
    externalId: body.externalId,
    instructions: body.instructions ?? null,
    chatId: chat.id as number,
  });

  if (actor === 'agent_and_chat_exclusive') {
    ctx.status = 400;
    ctx.body = { error: 'agentId and chatId are mutually exclusive' };
    return;
  }

  ctx.status = 201;
  ctx.body = actor;
});
