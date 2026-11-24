// Side-effect import: registers the tool-call approval resume handler (Milestone
// 1) so a resolved `origin: tool_call` item fires its continuation generation.
import 'src/lib/agentToolApprovalContinuation';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  type AcceptedGeneration,
  createGeneration,
  createIdempotentGeneration,
  startGeneration,
  submitToolOutputs,
} from 'src/lib/agentGeneration';
import { mapGenerationResult } from 'src/lib/agentGenerationHelpers';
import type { GenerationIds } from 'src/lib/agentGenerationTypes';
import type { StreamedGenerationPart } from 'src/lib/agentStreamGeneration';
import { storeResumedConversationTurn } from 'src/lib/conversationGeneration';
import type { GenerationInputMessage } from 'src/lib/generationInputMessages';
import { validateMetadataBag } from 'src/lib/metadataBag';
import { serveSse, type SseFrame } from 'src/lib/sse';
import { captureAuthority } from 'src/lib/workAuthority';

import { authorizeAgentWrite } from './agentAccess';
import { authorizeGenerationResume } from './generations';
import { resolveStreamWait, withProgressFrames } from './generationStream';
import { parseToolContextBody } from './helpers';
import { idempotencyKeyOf } from './idempotencyKey';
import { authorizeSharedUse } from './sharedAccess';

const toSseFrame = (part: StreamedGenerationPart): SseFrame => {
  if (typeof part === 'string') {
    return { data: { choices: [{ delta: { content: part } }] } };
  }
  return { data: mapGenerationResult(part.generation) };
};

async function* framesOf(
  stream: ReadableStream<StreamedGenerationPart>
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.value !== undefined) yield toSseFrame(chunk.value);
    if (chunk.done) return;
  }
}

/**
 * The `200` goes out before the provider is called, so a failure becomes the
 * terminal error frame. The stream's error is the one the generation records.
 * Text frames carry no SSE event name; the progress rows interleaved with them
 * are `progress` events.
 */
const sendStreamResponse = async (args: {
  ctx: Context;
  result: ReadableStream<StreamedGenerationPart>;
  recorded: GenerationIds | undefined;
}): Promise<void> => {
  const text = framesOf(args.result);
  await serveSse({
    ctx: args.ctx,
    frames: args.recorded
      ? withProgressFrames({
          frames: text,
          generationId: args.recorded.generationId,
        })
      : text,
    label: 'agentGeneration stream',
    resume: args.recorded && {
      generation_id: args.recorded.generationId,
      trace_id: args.recorded.traceId,
    },
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
    return validateMetadataBag(body.metadata);
  }
  return null;
};

export const agentGenerationRouter = new Router<Context>();

type GenerateRequestBody = {
  messages?: unknown;
  stream?: boolean;
  trace_id?: string;
  parent_trace_id?: string;
  root_trace_id?: string;
  max_call_depth?: unknown;
  tool_context?: unknown;
  knowledge_config?: object;
  action_id?: string;
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
  runProjectId?: number;
}) => {
  const { ctx, body } = args;
  return {
    projectIds: args.projectIds,
    runProjectId: args.runProjectId,
    agentId: ctx.params.agent_id,
    messages: body.messages as GenerationInputMessage[],
    traceId: body.trace_id,
    parentTraceId: body.parent_trace_id,
    rootTraceId: body.root_trace_id,
    remainingDepth:
      typeof body.max_call_depth === 'number' ? body.max_call_depth : undefined,
    authority: captureAuthority({ authUser: ctx.authUser }),
    authUser: ctx.authUser,
    toolContext: parseToolContextBody({
      raw: body.tool_context,
      reservedPrefix: 'refuse',
    }),
    actorId: ctx.authUser?.actor ?? undefined,
    knowledgeConfig: toObjectOrUndefined(body.knowledge_config),
    actionId: typeof body.action_id === 'string' ? body.action_id : undefined,
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
    guardrailContext: isRecord(body.guardrail_context)
      ? body.guardrail_context
      : undefined,
    idempotencyKey: idempotencyKeyOf(ctx),
  };
};

/** A background start, and every replay: the generation is read by polling. */
const respondAccepted = (args: {
  ctx: Context;
  accepted: AcceptedGeneration;
}): void => {
  const { ctx, accepted } = args;
  ctx.status = 202;
  ctx.body = {
    status: accepted.status,
    generation_id: accepted.id,
    trace_id: accepted.traceId,
  };
};

/**
 * The blocking run. An unkeyed request calls `createGeneration` itself: it is
 * the provider boundary the test suite's sanctioned spy sits on.
 */
const runWaitedGeneration = (args: {
  generationArgs: ReturnType<typeof buildGenerationArgs>;
  stream: boolean;
  onRecorded: (ids: GenerationIds) => void;
}) => {
  const { generationArgs, stream, onRecorded } = args;
  const { idempotencyKey } = generationArgs;
  return idempotencyKey
    ? createIdempotentGeneration({
        ...generationArgs,
        idempotencyKey,
        stream,
        onRecorded,
      })
    : createGeneration({ ...generationArgs, stream, onRecorded });
};

agentGenerationRouter.post(
  '/agents/:agent_id/generate',
  async (ctx: Context) => {
    // Through a share the turn runs, and is recorded, in the grantee project.
    const shared = await authorizeSharedUse({
      ctx,
      resourceType: 'agent',
      resourceId: ctx.params.agent_id,
      action: 'agents:CreateAgentGeneration',
    });
    const projectIds = shared
      ? [shared.projectId]
      : (
          await authorizeAgentWrite({
            ctx,
            action: 'agents:CreateAgentGeneration',
          })
        ).projectIds;

    const body = ctx.request.body as GenerateRequestBody;

    const bodyError = validateGenerateBody({
      messages: body.messages,
      metadata: body.metadata,
    });
    if (bodyError) {
      throw new DomainError('VALIDATION_FAILED', bodyError);
    }

    const generationArgs = buildGenerationArgs({
      ctx,
      body,
      projectIds,
      runProjectId: shared?.projectId,
    });

    if (!resolveStreamWait({ ctx, stream: body.stream })) {
      respondAccepted({ ctx, accepted: await startGeneration(generationArgs) });
      return;
    }

    let recorded: GenerationIds | undefined;
    const result = await runWaitedGeneration({
      generationArgs,
      stream: body.stream === true,
      onRecorded: (ids) => {
        recorded = ids;
      },
    });
    if ('idempotent' in result) {
      respondAccepted({ ctx, accepted: result });
      return;
    }

    if ('getReader' in result) {
      await sendStreamResponse({ ctx, result, recorded });
      return;
    }
    ctx.body = mapGenerationResult(result);
  }
);

agentGenerationRouter.post(
  '/agents/:agent_id/generate/:generation_id/tool-outputs',
  async (ctx: Context) => {
    const shared = await authorizeSharedUse({
      ctx,
      resourceType: 'agent',
      resourceId: ctx.params.agent_id,
      action: 'agents:CreateAgentGeneration',
    });
    const projectIds = shared
      ? [shared.projectId]
      : (
          await authorizeAgentWrite({
            ctx,
            action: 'agents:CreateAgentGeneration',
          })
        ).projectIds;

    const { tool_outputs: toolOutputs } = ctx.request.body as {
      tool_outputs?: Array<{ tool_call_id: string; output: unknown }>;
    };

    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'toolOutputs is required and must be a non-empty array'
      );
    }

    await authorizeGenerationResume({
      ctx,
      generationId: ctx.params.generation_id,
    });

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
      authority: captureAuthority({ authUser: ctx.authUser }),
    });
    await storeResumedConversationTurn({
      result,
      agentId: ctx.params.agent_id,
    });

    ctx.body = mapGenerationResult(result);
  }
);
