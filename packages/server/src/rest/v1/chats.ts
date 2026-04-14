import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import type { ChatMessage } from 'src/lib/chats';
import { createChatCompletion, streamChatCompletion } from 'src/lib/chats';

export const chatsRouter = new Router<Context>();

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
