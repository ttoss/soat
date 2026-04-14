import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
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

export const chatsRouter = new Router<Context>();

/**
 * @openapi
 * /chats:
 *   post:
 *     tags:
 *       - Chats
 *     summary: Create a chat
 *     description: Creates a new chat resource bound to an AI provider.
 *     operationId: createChat
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateChatRequest'
 *     responses:
 *       '201':
 *         description: Chat created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Chat'
 *       '400':
 *         description: Bad Request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: AI provider not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
chatsRouter.post('/chats', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const {
    aiProviderId,
    name,
    systemMessage,
    model,
    projectId: projectPublicId,
  } = ctx.request.body as {
    aiProviderId?: unknown;
    name?: unknown;
    systemMessage?: unknown;
    model?: unknown;
    projectId?: string;
  };

  if (!aiProviderId || typeof aiProviderId !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'aiProviderId is required' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'chats:CreateChat',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const targetProjectId = projectIds?.[0] ?? ctx.authUser.projectKeyProjectId;

  if (!targetProjectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return;
  }

  const result = await createChat({
    projectId: targetProjectId,
    aiProviderId,
    name: typeof name === 'string' ? name : undefined,
    systemMessage:
      typeof systemMessage === 'string' ? systemMessage : undefined,
    model: typeof model === 'string' ? model : undefined,
  });

  if (result === 'ai_provider_not_found') {
    ctx.status = 404;
    ctx.body = { error: 'AI provider not found' };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /chats:
 *   get:
 *     tags:
 *       - Chats
 *     summary: List chats
 *     description: Returns all chats in the project.
 *     operationId: listChats
 *     parameters:
 *       - name: projectId
 *         in: query
 *         required: false
 *         description: Project public ID to filter by
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: List of chats
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Chat'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
chatsRouter.get('/chats', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'chats:ListChats',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listChats({ projectIds: projectIds ?? [] });
});

/**
 * @openapi
 * /chats/{chatId}:
 *   get:
 *     tags:
 *       - Chats
 *     summary: Get a chat
 *     description: Returns a single chat by ID.
 *     operationId: getChat
 *     parameters:
 *       - name: chatId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Chat record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Chat'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Chat not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
chatsRouter.get('/chats/:chatId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { chatId } = ctx.params;

  const chat = await getChat({ id: chatId });

  if (!chat) {
    ctx.status = 404;
    ctx.body = { error: 'Chat not found' };
    return;
  }

  ctx.body = chat;
});

/**
 * @openapi
 * /chats/{chatId}:
 *   delete:
 *     tags:
 *       - Chats
 *     summary: Delete a chat
 *     description: Deletes a chat by ID.
 *     operationId: deleteChat
 *     parameters:
 *       - name: chatId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '204':
 *         description: Chat deleted
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Chat not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
chatsRouter.delete('/chats/:chatId', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { chatId } = ctx.params;

  const result = await deleteChat({ id: chatId });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Chat not found' };
    return;
  }

  ctx.status = 204;
});

/**
 * @openapi
 * /chats/{chatId}/completions:
 *   post:
 *     tags:
 *       - Chats
 *     summary: Create a chat completion for a stored chat
 *     description: >
 *       Runs a completion using the AI provider and settings stored in the chat.
 *       Pass `stream: true` for SSE streaming. Optionally override the model per
 *       request. If a system message is included in `messages`, it replaces the
 *       chat's stored system message for this call only. Messages may include a
 *       `documentId` instead of `content` — the document content will be resolved
 *       automatically.
 *     operationId: createChatCompletionForChat
 *     parameters:
 *       - name: chatId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatCompletionForChatRequest'
 *     responses:
 *       '200':
 *         description: Chat completion result (JSON or SSE stream)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatCompletionResponse'
 *           text/event-stream:
 *             schema:
 *               type: string
 *               description: SSE stream of chat completion delta chunks
 *       '400':
 *         description: Bad Request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Chat or AI provider not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
chatsRouter.post('/chats/:chatId/completions', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { chatId } = ctx.params;

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
    ctx.respond = false;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const textStream = await streamChatCompletionForChat({
        chatId,
        messages: chatMessages,
        model,
      });

      if (typeof textStream === 'string') {
        ctx.res.write(`data: ${JSON.stringify({ error: textStream })}\n\n`);
        ctx.res.end();
        return;
      }

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
 * @openapi
 * /chats/completions:
 *   post:
 *     tags:
 *       - Chats
 *     summary: Create a chat completion
 *     description: >
 *       OpenAI Chat Completions-compatible endpoint. Resolves the AI provider
 *       from `aiProviderId`, decrypts its secret, and calls the appropriate
 *       Vercel AI SDK provider. Falls back to Ollama when `aiProviderId` is
 *       omitted.
 *     operationId: createChatCompletion
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatCompletionRequest'
 *     responses:
 *       '200':
 *         description: Chat completion result (JSON or SSE stream)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatCompletionResponse'
 *           text/event-stream:
 *             schema:
 *               type: string
 *               description: SSE stream of chat completion delta chunks
 *       '400':
 *         description: Bad Request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: AI provider not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
chatsRouter.post('/chats/completions', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { aiProviderId, model, messages, stream } = ctx.request.body as {
    aiProviderId?: string;
    model?: string;
    messages?: unknown;
    stream?: boolean;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'messages is required and must be a non-empty array' };
    return;
  }

  const chatMessages = messages as ChatMessage[];

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
