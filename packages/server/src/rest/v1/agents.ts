import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { streamAgent } from 'src/lib/agents';

const agentsRouter = new Router<Context>();

/**
 * @openapi
 * /agents/run/stream:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Stream an agent response via SSE
 *     description: Streams a text response from the agent using Server-Sent Events. Requires authentication.
 *     operationId: runAgentStream
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - prompt
 *             properties:
 *               model:
 *                 type: string
 *                 description: Model name to use. Defaults to AGENT_MODEL env var.
 *                 example: qwen2.5:0.5b
 *               prompt:
 *                 type: string
 *                 description: The user prompt to send to the agent.
 *                 example: Hello, who are you?
 *     responses:
 *       '200':
 *         description: SSE stream of text chunks
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       '400':
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 */
agentsRouter.post('/agents/run/stream', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as { model?: string; prompt?: string };
  const model = body.model ?? process.env.AGENT_MODEL;

  if (!model || !body.prompt) {
    ctx.status = 400;
    ctx.body = {
      error:
        'prompt is required, and model must be provided or set via AGENT_MODEL',
    };
    return;
  }

  ctx.respond = false;
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const stream = await streamAgent({ model, prompt: body.prompt });
    for await (const chunk of stream) {
      const text = chunk.message.content;
      if (text) {
        ctx.res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }
    ctx.res.write('event: done\ndata: {}\n\n');
  } catch (error) {
    ctx.res.write(
      `event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`
    );
  } finally {
    ctx.res.end();
  }
});

export { agentsRouter };
