// Side-effect import: registers the tool-call approval resume handler (Milestone
// 1) so a resolved `origin: tool_call` item fires its continuation generation.
import 'src/lib/agentToolApprovalContinuation';

import type { ServerResponse } from 'node:http';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { GenerationResult } from 'src/lib/agentGeneration';
import {
  createGeneration,
  startGeneration,
  submitToolOutputs,
} from 'src/lib/agentGeneration';
import { mapGenerationResult } from 'src/lib/agentGenerationHelpers';
import type { GenerationInputMessage } from 'src/lib/generationInputMessages';
import { validateGenerationMetadata } from 'src/lib/generationMetadata';
import {
  type ExtractionMessage,
  fireMemoryExtraction,
} from 'src/lib/memoryExtraction';
import { hasSystemMessage } from 'src/lib/modelMessages';

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

/**
 * An agent's system prompt is its `instructions` field, so a `role: "system"`
 * entry in a generation request is refused rather than accommodated.
 *
 * This is deliberately at the REST boundary: `messages` here came from the
 * request, whereas internal callers legitimately build system content of their
 * own — a session generation reaches the same agent path through
 * `conversationGeneration`, which prepends the actor persona as a system
 * message. A guard further down would reject those flows too.
 *
 * It used to be resolved by position rather than by rule: `instructions` was
 * taken from the *first* system message of the combined history, so a caller's
 * system message won on an agent whose `instructions` was empty and was silently
 * dropped on one where it was set. Refusing it mirrors the AI SDK, which defaults
 * `allowSystemInMessages` to false because a system message inside a
 * caller-supplied array is a prompt-injection vector.
 */
const assertNoSystemMessage = (messages: unknown): void => {
  if (!Array.isArray(messages)) return;
  if (!hasSystemMessage(messages)) return;

  throw new DomainError(
    'SYSTEM_MESSAGE_NOT_ALLOWED',
    "A system message is not accepted in `messages`. An agent's system prompt is its `instructions` field \u2014 set it with `update-agent --instructions`, or create a separate agent."
  );
};

export const agentGenerationRouter = new Router<Context>();

type GenerateRequestBody = {
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

/**
 * Maps the wire body onto the lib's generation args. Shared by the blocking and
 * background paths so the two can never drift in what they forward.
 */
const buildGenerationArgs = (args: {
  ctx: Context;
  body: GenerateRequestBody;
  projectIds?: number[];
}) => {
  const { ctx, body } = args;
  return {
    projectIds: args.projectIds,
    agentId: ctx.params.agent_id,
    messages: body.messages as GenerationInputMessage[],
    traceId: body.trace_id,
    parentTraceId: body.parent_trace_id,
    rootTraceId: body.root_trace_id,
    remainingDepth:
      typeof body.max_call_depth === 'number' ? body.max_call_depth : undefined,
    authHeader: (ctx.headers.authorization as string) ?? '',
    authUser: ctx.authUser,
    toolContext: body.tool_context,
    knowledgeConfig: toObjectOrUndefined(body.knowledge_config),
    actionId: typeof body.action_id === 'string' ? body.action_id : undefined,
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
    guardrailContext: isRecord(body.guardrail_context)
      ? body.guardrail_context
      : undefined,
  };
};

/**
 * Resolves whether this request blocks. Background is the default; a stream
 * holds the request open by definition, so `stream: true` implies waiting, and
 * asking for both a stream and a background run is contradictory rather than
 * silently resolved either way.
 */
const resolveWait = (args: { ctx: Context; stream?: boolean }): boolean => {
  const requested = args.ctx.query['wait'];
  if (args.stream === true && requested === 'false') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'stream and wait=false are mutually exclusive: a streamed generation must hold the request open. Omit stream, or omit wait=false.'
    );
  }
  return requested === 'true' || args.stream === true;
};

agentGenerationRouter.post(
  '/agents/:agent_id/generate',
  async (ctx: Context) => {
    requireAuth(ctx);

    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:CreateAgentGeneration',
      resourceType: 'agent',
    });

    const body = ctx.request.body as GenerateRequestBody;

    const bodyError = validateGenerateBody({
      messages: body.messages,
      metadata: body.metadata,
    });
    if (bodyError) {
      throw new DomainError('VALIDATION_FAILED', bodyError);
    }
    assertNoSystemMessage(body.messages);

    const generationArgs = buildGenerationArgs({ ctx, body, projectIds });

    if (!resolveWait({ ctx, stream: body.stream })) {
      const accepted = await startGeneration(generationArgs);
      ctx.status = 202;
      ctx.body = {
        status: accepted.status,
        generation_id: accepted.id,
        trace_id: accepted.traceId,
      };
      return;
    }

    const result = await createGeneration({
      ...generationArgs,
      stream: body.stream === true,
    });

    fireExtractionForCompletedResult({
      agentId: ctx.params.agent_id,
      projectIds,
      result,
      messages: body.messages as ExtractionMessage[],
      extract: typeof body.extract === 'boolean' ? body.extract : undefined,
    });

    await handleGenerationResult(ctx, result, body.stream);
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
