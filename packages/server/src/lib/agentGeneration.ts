import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';
import type { AuthUser } from 'src/Context';

import { DomainError } from '../errors';
import {
  buildGenerationContext,
  type GenerationContext,
} from './agentGenerationContext';
import {
  type GenerationResult,
  pendingGenerations,
  runStreamGeneration,
} from './agentGenerationHelpers';
import {
  buildDepthGuardResult,
  recoverPendingFromDb,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import {
  buildToolResultMessages as buildToolResultMessagesFromOutputs,
  loadOutputMappingsByToolName,
  resolveToolOutputsResult,
  runNonStreamGeneration,
  runToolOutputsGeneration,
} from './agentNonStreamGeneration';
import { type GenerationInputMessage } from './generationInputMessages';
import { recordGenerationFailure } from './generationLifecycle';
import { createGenerationRecord } from './generations';
import { assertStreamingSupportsOutputSchema } from './outputSchema';

const log = createDebug('soat:generation');

export type { GenerationResult };

// ── Create Generation ─────────────────────────────────────────────────────

const dispatchGeneration = (args: {
  stream: boolean | undefined;
  ctx: GenerationContext;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  abortSignal?: AbortSignal;
}): Promise<GenerationResult | ReadableStream> => {
  if (args.stream) {
    assertStreamingSupportsOutputSchema(args.ctx.typedAgent.outputSchema);
    const stream = runStreamGeneration({
      model: args.ctx.model,
      allMessages: args.ctx.allMessages,
      resolvedTools: args.ctx.resolvedTools,
      typedAgent: args.ctx.typedAgent,
      generationId: args.ctx.generationId,
      traceId: args.traceId,
      agentId: args.agentId,
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
    });
    return Promise.resolve(stream);
  }
  return runNonStreamGeneration({
    model: args.ctx.model,
    allMessages: args.ctx.allMessages,
    resolvedTools: args.ctx.resolvedTools,
    typedAgent: args.ctx.typedAgent,
    generationId: args.ctx.generationId,
    traceId: args.traceId,
    agentId: args.agentId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    abortSignal: args.abortSignal,
    toolContext: args.ctx.toolContext ?? null,
    remainingDepth: args.ctx.remainingDepth ?? null,
  });
};

// Builds the generation's creation-time metadata from usage-attribution
// inputs. Only defined keys are stored; returns null when there is nothing to
// attribute, preserving the previous `metadata: null` default.
const buildGenerationMetadata = (args: {
  actionId?: string;
  triggerId?: string;
}): Record<string, unknown> | null => {
  const metadata: Record<string, unknown> = {};
  if (args.actionId !== undefined) metadata.actionId = args.actionId;
  if (args.triggerId !== undefined) metadata.triggerId = args.triggerId;
  return Object.keys(metadata).length > 0 ? metadata : null;
};

const resolveContextAndRecord = async (args: {
  agentId: string;
  projectIds?: number[];
  messages: GenerationInputMessage[];
  authHeader?: string;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  knowledgeConfig?: object;
  actionId?: string;
  triggerId?: string;
}): Promise<GenerationContext> => {
  const ctx = await buildGenerationContext({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    knowledgeConfig: args.knowledgeConfig,
  });

  // Awaited so the record reliably exists before the generation runs and a
  // failure can be persisted on it. Creation failures are non-fatal.
  await createGenerationRecord({
    publicId: ctx.generationId,
    projectId: ctx.typedAgent.project.id as number,
    agentId: args.agentId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    startedByPrincipalType: null,
    startedByPrincipalId: null,
    metadata: buildGenerationMetadata({
      actionId: args.actionId,
      triggerId: args.triggerId,
    }),
  }).catch((error) => {
    log(
      'resolveContextAndRecord: failed to create generation record generationId=%s error=%s',
      ctx.generationId,
      error instanceof Error ? error.message : String(error)
    );
  });

  return ctx;
};

export const createGeneration = async (args: {
  projectIds?: number[];
  agentId: string;
  messages: GenerationInputMessage[];
  stream?: boolean;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  authHeader?: string;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  knowledgeConfig?: object;
  actionId?: string;
  triggerId?: string;
}): Promise<GenerationResult | ReadableStream> => {
  const maxDepth = args.remainingDepth ?? 10;
  const traceId = args.traceId ?? generatePublicId(PUBLIC_ID_PREFIXES.trace);

  if (maxDepth <= 0) {
    const depthAgent = await resolveAgentForGeneration({
      agentId: args.agentId,
      projectIds: args.projectIds,
    });
    if (!depthAgent) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Agent '${args.agentId}' not found.`
      );
    }
    const depthGenId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    return buildDepthGuardResult({
      traceId,
      projectId: depthAgent.project.id as number,
      projectPublicId: depthAgent.project.publicId,
      agentId: args.agentId,
      generationId: depthGenId,
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
    });
  }

  const ctx = await resolveContextAndRecord({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    toolContext: args.toolContext,
    traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    initiatorGenerationId: args.initiatorGenerationId,
    remainingDepth: maxDepth,
    knowledgeConfig: args.knowledgeConfig,
    actionId: args.actionId,
    triggerId: args.triggerId,
  });

  log('createGeneration: agentId=%s stream=%s', args.agentId, args.stream);

  try {
    return await dispatchGeneration({
      stream: args.stream,
      ctx,
      traceId,
      agentId: args.agentId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      abortSignal: args.abortSignal,
    });
  } catch (error) {
    throw await recordGenerationFailure({
      generationId: ctx.generationId,
      traceId,
      error,
    });
  }
};

// ── Submit Tool Outputs ───────────────────────────────────────────────────

export const submitToolOutputs = async (args: {
  projectIds?: number[];
  agentId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
  authHeader?: string;
}): Promise<GenerationResult> => {
  let pending = pendingGenerations.get(args.generationId);

  // If not in memory (e.g. server restarted), recover from DB.
  if (!pending) {
    pending = await recoverPendingFromDb({
      generationId: args.generationId,
      agentId: args.agentId,
      projectIds: args.projectIds,
      authHeader: args.authHeader,
    });
  }
  if (!pending || pending.agentId !== args.agentId) {
    throw new DomainError(
      'GENERATION_NOT_FOUND',
      `Generation '${args.generationId}' not found or does not belong to agent '${args.agentId}'.`
    );
  }

  pendingGenerations.delete(args.generationId);

  const toolResultMessages = buildToolResultMessagesFromOutputs({
    toolOutputs: args.toolOutputs,
    pendingToolCalls: pending.pendingToolCalls,
    outputMappingsByToolName: await loadOutputMappingsByToolName(pending),
  });
  const allMessages = [...pending.messages, ...toolResultMessages];
  const system = (
    pending.messages as Array<{ role: string; content: string }>
  ).find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = allMessages.filter((m) => {
    return (m as { role?: string }).role !== 'system';
  });

  const result = await runToolOutputsGeneration({
    generationId: args.generationId,
    pending,
    system,
    nonSystemMessages,
  });

  return resolveToolOutputsResult({
    generationId: args.generationId,
    agentId: args.agentId,
    pending,
    allMessages,
    result,
  });
};
