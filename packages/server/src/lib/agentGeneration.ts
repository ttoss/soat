import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, Tool } from 'ai';
import createDebug from 'debug';
import type { AuthUser } from 'src/Context';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { DomainError } from '../errors';
import {
  buildAllMessages,
  type GenerationResult,
  pendingGenerations,
  runStreamGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import {
  buildDepthGuardResult,
  recoverPendingFromDb,
  resolveAgentForGeneration,
} from './agentGenerationRecovery';
import { buildKnowledgeMessages, buildKnowledgeTools } from './agentKnowledge';
import { buildModel } from './agentModel';
import {
  buildToolResultMessages as buildToolResultMessagesFromOutputs,
  loadOutputMappingsByToolName,
  resolveToolOutputsResult,
  runNonStreamGeneration,
  runToolOutputsGeneration,
} from './agentNonStreamGeneration';
import { resolveAgentTools } from './agentToolResolver';
import {
  type GenerationInputMessage,
  resolveGenerationInputMessages,
} from './generationInputMessages';
import { recordGenerationFailure } from './generationLifecycle';
import { createGenerationRecord } from './generations';
import { assertStreamingSupportsOutputSchema } from './outputSchema';
import {
  type ProviderOptionsMap,
  type ReasoningConfig,
  resolveReasoningForContext,
} from './reasoning';

const log = createDebug('soat:generation');

export type { GenerationResult };

// ── Build Generation Context ──────────────────────────────────────────────

type GenerationContext = {
  typedAgent: TypedAgent;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  allMessages: Array<{ role: string; content: unknown }>;
  generationId: string;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
  reasoningConfig?: ReasoningConfig | null;
  providerOptions?: ProviderOptionsMap;
  maxOutputTokens?: number;
};

const resolveGenerationModel = async (args: {
  agentId: string;
  typedAgent: TypedAgent;
}) => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.typedAgent.aiProvider.publicId,
  });

  if (!resolved) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider for agent '${args.agentId}' could not be resolved.`
    );
  }

  const model = await buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  return { model, provider: resolved.provider };
};

const assembleContextMessages = async (args: {
  agentId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  resolvedMessages: Array<{ role: string; content: unknown }>;
}): Promise<Array<{ role: string; content: unknown }>> => {
  const knowledgeMessages = await buildKnowledgeMessages({
    knowledgeConfig: args.typedAgent.knowledgeConfig,
    projectIds: args.projectIds,
    messages: args.resolvedMessages,
  });

  log(
    'assembleContextMessages: agentId=%s knowledgeMessages=%d userMessages=%d',
    args.agentId,
    knowledgeMessages.length,
    args.resolvedMessages.length
  );

  const allMessages = buildAllMessages(args.typedAgent.instructions, [
    ...knowledgeMessages,
    ...args.resolvedMessages,
  ]);

  log('assembleContextMessages: allMessages=%o', allMessages);

  return allMessages;
};

const buildGenerationContext = async (args: {
  agentId: string;
  projectIds?: number[];
  messages: GenerationInputMessage[];
  authHeader?: string;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  reasoning?: object;
}): Promise<GenerationContext> => {
  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });

  if (!typedAgent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );

  const resolvedMessages = await resolveGenerationInputMessages({
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    authUser: args.authUser,
    allowedToolIds: Array.isArray(typedAgent.toolIds)
      ? (typedAgent.toolIds as string[])
      : undefined,
    agentBoundaryPolicy: typedAgent.boundaryPolicy,
  });
  const { model, provider } = await resolveGenerationModel({
    agentId: args.agentId,
    typedAgent,
  });

  const { reasoningConfig, reasoningOptions } = resolveReasoningForContext({
    typedAgent,
    override: args.reasoning,
    provider,
  });

  const resolvedTools = typedAgent.toolIds
    ? await resolveAgentTools({
        toolIds: typedAgent.toolIds as string[],
        projectIds: args.projectIds,
        boundaryPolicy: typedAgent.boundaryPolicy,
        authHeader: args.authHeader,
        toolContext: args.toolContext,
        traceId: args.traceId,
        parentTraceId: args.parentTraceId,
        rootTraceId: args.rootTraceId,
        remainingDepth: args.remainingDepth,
      })
    : {};

  buildKnowledgeTools({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent,
    resolvedTools,
  });

  const allMessages = await assembleContextMessages({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent,
    resolvedMessages,
  });

  return {
    typedAgent,
    model,
    resolvedTools,
    allMessages,
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    toolContext: args.toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
    reasoningConfig,
    providerOptions: reasoningOptions?.providerOptions,
    maxOutputTokens: reasoningOptions?.maxOutputTokens,
  };
};

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
      providerOptions: args.ctx.providerOptions,
      maxOutputTokens: args.ctx.maxOutputTokens,
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
    providerOptions: args.ctx.providerOptions,
    maxOutputTokens: args.ctx.maxOutputTokens,
    reasoningConfig: args.ctx.reasoningConfig,
  });
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
  reasoning?: object;
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
    reasoning: args.reasoning,
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
  reasoning?: object;
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
    reasoning: args.reasoning,
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
