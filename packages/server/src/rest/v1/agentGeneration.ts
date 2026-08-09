// Side-effect import: registers the tool-call approval resume handler (Milestone
// 1) so a resolved `origin: tool_call` item fires its continuation generation.
import 'src/lib/agentToolApprovalContinuation';

import type { ServerResponse } from 'node:http';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { GenerationResult } from 'src/lib/agentGeneration';
import { mapGenerationResult } from 'src/lib/agentGenerationHelpers';
import { createGeneration, submitToolOutputs } from 'src/lib/agents';
import type { GenerationInputMessage } from 'src/lib/generationInputMessages';
import { validateGenerationMetadata } from 'src/lib/generationMetadata';
import {
  type ExtractionMessage,
  fireMemoryExtraction,
} from 'src/lib/memoryExtraction';

import { requireAuth, resolveReadProjectIds } from './helpers';

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
  ctx.body = mapGenerationResult(result as GenerationResult);
};

const fireExtractionForCompletedResult = (args: {
  agentId: string;
  projectIds?: number[];
  result: GenerationResult | ReadableStream;
  messages: ExtractionMessage[];
  extract?: boolean;
}): void => {
  if (
    args.result instanceof ReadableStream ||
    args.result.status !== 'completed'
  ) {
    return;
  }
  fireMemoryExtraction({
    agentId: args.agentId,
    projectIds: args.projectIds,
    generationId: args.result.id,
    messages: args.messages,
    assistantContent: args.result.output?.content ?? '',
    extract: args.extract,
  });
};

const toObjectOrUndefined = (value: unknown): object | undefined => {
  return value && typeof value === 'object' ? value : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// Validates the create-generation request body. Returns an error message when
// invalid, or null when the body is acceptable. Kept out of the handler so the
// handler stays within its complexity budget.
const validateGenerateBody = (body: {
  messages?: unknown;
  metadata?: unknown;
}): string | null => {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'messages is required and must be a non-empty array';
  }
  if (body.metadata !== undefined) {
    return validateGenerationMetadata(body.metadata);
  }
  return null;
};

export const agentGenerationRouter = new Router<Context>();

agentGenerationRouter.post(
  '/agents/:agent_id/generate',
  async (ctx: Context) => {
    requireAuth(ctx);

    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:CreateAgentGeneration',
      resourceType: 'agent',
    });

    const {
      messages,
      stream,
      trace_id: traceId,
      parent_trace_id: parentTraceId,
      root_trace_id: rootTraceId,
      max_call_depth: maxCallDepth,
      tool_context: toolContext,
      knowledge_config: knowledgeConfig,
      action_id: actionId,
      extract,
      metadata,
      guardrail_context: guardrailContext,
    } = ctx.request.body as {
      messages?: unknown;
      stream?: boolean;
      trace_id?: string;
      parent_trace_id?: string;
      root_trace_id?: string;
      max_call_depth?: unknown;
      tool_context?: Record<string, string>;
      knowledge_config?: object;
      action_id?: string;
      extract?: boolean;
      metadata?: unknown;
      guardrail_context?: unknown;
    };

    const bodyError = validateGenerateBody({ messages, metadata });
    if (bodyError) {
      throw new DomainError('VALIDATION_FAILED', bodyError);
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
      knowledgeConfig: toObjectOrUndefined(knowledgeConfig),
      actionId: typeof actionId === 'string' ? actionId : undefined,
      metadata: isRecord(metadata) ? metadata : undefined,
      guardrailContext: isRecord(guardrailContext)
        ? guardrailContext
        : undefined,
    });

    fireExtractionForCompletedResult({
      agentId: ctx.params.agent_id,
      projectIds,
      result,
      messages: messages as ExtractionMessage[],
      extract: typeof extract === 'boolean' ? extract : undefined,
    });

    await handleGenerationResult(ctx, result, stream);
  }
);

agentGenerationRouter.post(
  '/agents/:agent_id/generate/:generation_id/tool-outputs',
  async (ctx: Context) => {
    requireAuth(ctx);

    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:CreateAgentGeneration',
      resourceType: 'agent',
    });

    const { tool_outputs: toolOutputs } = ctx.request.body as {
      tool_outputs?: Array<{ tool_call_id: string; output: unknown }>;
    };

    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'toolOutputs is required and must be a non-empty array'
      );
    }

    const result = await submitToolOutputs({
      projectIds,
      agentId: ctx.params.agent_id,
      generationId: ctx.params.generation_id,
      toolOutputs: toolOutputs.map((toolOutput) => {
        return {
          toolCallId: toolOutput.tool_call_id,
          output: toolOutput.output,
        };
      }),
      authHeader: (ctx.headers.authorization as string) ?? undefined,
    });

    ctx.body = mapGenerationResult(result);
  }
);
