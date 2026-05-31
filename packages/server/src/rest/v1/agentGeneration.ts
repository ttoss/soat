import type { ServerResponse } from 'node:http';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import type { GenerationResult } from 'src/lib/agentGeneration';
import type { GenerationInputMessage } from 'src/lib/generationInputMessages';
import { createGeneration, submitToolOutputs } from 'src/lib/agents';

const pipeStreamToResponse = async (
  stream: ReadableStream,
  res: ServerResponse
): Promise<void> => {
  const reader = stream.getReader();
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: chunk.value } }] })}\n\n`
      );
    }
  }
  res.write('data: [DONE]\n\n');
};

const sendStreamResponse = async (
  ctx: Context,
  result: ReadableStream
): Promise<void> => {
  ctx.respond = false;
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  try {
    await pipeStreamToResponse(result, ctx.res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Internal server error';
    ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    ctx.res.end();
  }
};

const handleGenerationResult = async (
  ctx: Context,
  result: GenerationResult | ReadableStream,
  stream: boolean | undefined
): Promise<void> => {
  if (stream && result && typeof result === 'object' && 'getReader' in result) {
    await sendStreamResponse(ctx, result as ReadableStream);
    return;
  }
  ctx.body = result;
};

export const agentGenerationRouter = new Router<Context>();

agentGenerationRouter.post(
  '/agents/:agent_id/generate',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'agents:CreateAgentGeneration',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const {
      messages,
      stream,
      traceId,
      parentTraceId,
      rootTraceId,
      maxCallDepth,
      toolContext,
    } = ctx.request.body as {
      messages?: unknown;
      stream?: boolean;
      traceId?: string;
      parentTraceId?: string;
      rootTraceId?: string;
      maxCallDepth?: unknown;
      toolContext?: Record<string, string>;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      ctx.status = 400;
      ctx.body = {
        error: 'messages is required and must be a non-empty array',
      };
      return;
    }

    const result = await createGeneration({
      projectIds,
      agentId: ctx.params.agent_id,
      messages: messages as GenerationInputMessage[],
      stream: stream === true,
      traceId,
      parentTraceId,
      rootTraceId,
      remainingDepth:
        typeof maxCallDepth === 'number' ? maxCallDepth : undefined,
      authHeader: (ctx.headers.authorization as string) ?? '',
      authUser: ctx.authUser,
      toolContext,
    });

    await handleGenerationResult(ctx, result, stream);
  }
);

agentGenerationRouter.post(
  '/agents/:agent_id/generate/:generation_id/tool-outputs',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const projectIds = await ctx.authUser.resolveProjectIds({
      action: 'agents:CreateAgentGeneration',
    });

    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const { toolOutputs } = ctx.request.body as {
      toolOutputs?: unknown;
    };

    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      ctx.status = 400;
      ctx.body = {
        error: 'toolOutputs is required and must be a non-empty array',
      };
      return;
    }

    const result = await submitToolOutputs({
      projectIds,
      agentId: ctx.params.agent_id,
      generationId: ctx.params.generation_id,
      toolOutputs: toolOutputs as Array<{
        toolCallId: string;
        output: unknown;
      }>,
      authHeader: (ctx.headers.authorization as string) ?? undefined,
    });

    ctx.body = result;
  }
);
