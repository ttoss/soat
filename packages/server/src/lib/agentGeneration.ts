import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage, Tool } from 'ai';
import { generateText, stepCountIs } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  buildAllMessages,
  buildDepthGuardResult,
  type GenerationResult,
  pendingGenerations,
  runStreamGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import { buildKnowledgeMessages, buildWriteMemoryTool } from './agentKnowledge';
import { buildModel } from './agentModel';
import {
  buildPrepareStep,
  buildToolResultMessages as buildToolResultMessagesFromOutputs,
  runNonStreamGeneration,
} from './agentNonStreamGeneration';
import { resolveAgentTools } from './agentToolResolver';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { createGenerationRecord, updateGenerationRecord } from './generations';
import { saveTrace, serializeSteps } from './traces';

const log = createDebug('soat:generation');

export type { GenerationResult };

// ── Resolve Agent ─────────────────────────────────────────────────────────

const resolveAgentForGeneration = async (args: {
  agentId: string;
  projectIds?: number[];
}): Promise<TypedAgent | null> => {
  const where: Record<string, unknown> = { publicId: args.agentId };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({
    where,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.AiProvider, as: 'aiProvider' },
    ],
  });

  return agent as unknown as TypedAgent | null;
};

// ── Build Generation Context ──────────────────────────────────────────────

type GenerationContext = {
  typedAgent: TypedAgent;
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  allMessages: Array<{ role: string; content: string }>;
  generationId: string;
};

const buildGenerationContext = async (args: {
  agentId: string;
  projectIds?: number[];
  messages: Array<{ role: string; content: string }>;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
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

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedAgent.aiProvider.publicId,
  });

  if (!resolved)
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider for agent '${args.agentId}' could not be resolved.`
    );

  const model = buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
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

  const knowledgeConfig = typedAgent.knowledgeConfig as
    | { writeMemoryId?: string }
    | null
    | undefined;
  if (knowledgeConfig?.writeMemoryId) {
    resolvedTools['write_memory'] = buildWriteMemoryTool({
      writeMemoryId: knowledgeConfig.writeMemoryId,
    });
  }

  const knowledgeMessages = await buildKnowledgeMessages({
    knowledgeConfig: typedAgent.knowledgeConfig,
    projectIds: args.projectIds,
    messages: args.messages,
  });

  log(
    'buildGenerationContext: agentId=%s knowledgeMessages=%d userMessages=%d',
    args.agentId,
    knowledgeMessages.length,
    args.messages.length
  );

  const allMessages = buildAllMessages(typedAgent.instructions, [
    ...knowledgeMessages,
    ...args.messages,
  ]);

  log('buildGenerationContext: allMessages=%o', allMessages);

  return {
    typedAgent,
    model,
    resolvedTools,
    allMessages,
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
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
    const stream = runStreamGeneration({
      model: args.ctx.model,
      allMessages: args.ctx.allMessages,
      resolvedTools: args.ctx.resolvedTools,
      typedAgent: args.ctx.typedAgent,
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
  });
};

const resolveContextAndRecord = async (args: {
  agentId: string;
  projectIds?: number[];
  messages: Array<{ role: string; content: string }>;
  authHeader?: string;
  toolContext?: Record<string, string>;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
}): Promise<GenerationContext> => {
  const ctx = await buildGenerationContext({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
  });

  createGenerationRecord({
    publicId: ctx.generationId,
    projectId: ctx.typedAgent.project.id as number,
    agentId: args.agentId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    startedByPrincipalType: null,
    startedByPrincipalId: null,
  }).catch(() => {});

  return ctx;
};

export const createGeneration = async (args: {
  projectIds?: number[];
  agentId: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  authHeader?: string;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
}): Promise<GenerationResult | ReadableStream> => {
  const maxDepth = args.remainingDepth ?? 10;
  const traceId = args.traceId ?? generatePublicId(PUBLIC_ID_PREFIXES.trace);

  if (maxDepth <= 0) {
    const depthGenId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    return buildDepthGuardResult({
      traceId,
      projectId: args.projectIds?.[0] ?? 0,
      projectPublicId: '',
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
    toolContext: args.toolContext,
    traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    initiatorGenerationId: args.initiatorGenerationId,
    remainingDepth: maxDepth,
  });

  log('createGeneration: agentId=%s stream=%s', args.agentId, args.stream);

  return dispatchGeneration({
    stream: args.stream,
    ctx,
    traceId,
    agentId: args.agentId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    abortSignal: args.abortSignal,
  });
};

// ── Submit Tool Outputs ───────────────────────────────────────────────────

const fireCompletionSideEffects = (args: {
  generationId: string;
  pending: NonNullable<ReturnType<typeof pendingGenerations.get>>;
  result: { steps: unknown[]; finishReason: string };
  completedResult: GenerationResult;
}): void => {
  saveTrace({
    traceId: args.pending.traceId,
    projectId: args.pending.projectId,
    projectPublicId: args.pending.projectPublicId,
    agentId: args.pending.agentId,
    steps: serializeSteps(args.result.steps as unknown[]),
    parentTraceId: args.pending.parentTraceId ?? undefined,
    rootTraceId: args.pending.rootTraceId ?? undefined,
  }).catch(() => {});
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: args.result.finishReason,
  }).catch(() => {});
  resolveProjectPublicId({ projectId: args.pending.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'agents.generation.completed',
        projectId: args.pending.projectId,
        projectPublicId,
        resourceType: 'generation',
        resourceId: args.generationId,
        data: args.completedResult as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );
};

export const submitToolOutputs = async (args: {
  projectIds?: number[];
  agentId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
}): Promise<GenerationResult> => {
  const pending = pendingGenerations.get(args.generationId);

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
  });
  const allMessages = [...pending.messages, ...toolResultMessages];
  const typedPendingMessages = pending.messages as Array<{
    role: string;
    content: string;
  }>;
  const system = typedPendingMessages.find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = allMessages.filter((m) => {
    return (m as { role?: string }).role !== 'system';
  });

  const result = await generateText({
    model: pending.resolvedModel,
    system,
    messages: nonSystemMessages as ModelMessage[],
    tools:
      Object.keys(pending.resolvedTools).length > 0
        ? pending.resolvedTools
        : undefined,
    prepareStep: buildPrepareStep({
      stepRules: pending.agentConfig.stepRules,
      logContext: 'non_stream',
    }),
    stopWhen: stepCountIs(pending.agentConfig.maxSteps),
    temperature: pending.agentConfig.temperature ?? undefined,
  });

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: pending.traceId,
    status: 'completed',
    output: {
      model: result.response?.modelId ?? '',
      content: result.text,
      finishReason: result.finishReason,
    },
  };

  fireCompletionSideEffects({
    generationId: args.generationId,
    pending,
    result,
    completedResult,
  });

  return completedResult;
};
