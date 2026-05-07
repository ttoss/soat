import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage, Tool } from 'ai';
import { generateText, stepCountIs } from 'ai';
import createDebug from 'debug';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import {
  buildAllMessages,
  buildDepthGuardResult,
  type GenerationResult,
  pendingGenerations,
  runStreamGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import { buildModel } from './agentModel';
import {
  buildPrepareStep,
  buildToolResultMessages as buildToolResultMessagesFromOutputs,
  runNonStreamGeneration,
} from './agentNonStreamGeneration';
import { resolveAgentTools } from './agentToolResolver';
import { saveTrace, serializeSteps } from './agentTraces';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { createGenerationRecord, updateGenerationRecord } from './generations';

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
}): Promise<GenerationContext | 'not_found' | 'ai_provider_not_found'> => {
  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });

  if (!typedAgent) return 'not_found';

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedAgent.aiProvider.publicId,
  });

  if (!resolved) return 'ai_provider_not_found';

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
      })
    : {};

  return {
    typedAgent,
    model,
    resolvedTools,
    allMessages: buildAllMessages(typedAgent.instructions, args.messages),
    generationId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
  };
};

// ── Create Generation ─────────────────────────────────────────────────────

export const createGeneration = async (args: {
  projectIds?: number[];
  agentId: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  traceId?: string;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  authHeader?: string;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
}): Promise<
  GenerationResult | 'not_found' | 'ai_provider_not_found' | ReadableStream
> => {
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
    });
  }

  const ctx = await buildGenerationContext({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
  });

  log('createGeneration: agentId=%s stream=%s', args.agentId, args.stream);

  if (ctx === 'not_found' || ctx === 'ai_provider_not_found') return ctx;

  // Create the generation record in the DB (fire-and-forget errors)
  createGenerationRecord({
    publicId: ctx.generationId,
    projectId: ctx.typedAgent.project.id as number,
    agentId: args.agentId,
    traceId,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    startedByPrincipalType: null,
    startedByPrincipalId: null,
  }).catch(() => {});

  if (args.stream) {
    return runStreamGeneration({
      model: ctx.model,
      allMessages: ctx.allMessages,
      resolvedTools: ctx.resolvedTools,
      typedAgent: ctx.typedAgent,
      traceId,
      agentId: args.agentId,
    });
  }

  return runNonStreamGeneration({
    model: ctx.model,
    allMessages: ctx.allMessages,
    resolvedTools: ctx.resolvedTools,
    typedAgent: ctx.typedAgent,
    generationId: ctx.generationId,
    traceId,
    agentId: args.agentId,
    abortSignal: args.abortSignal,
  });
};

// ── Submit Tool Outputs ───────────────────────────────────────────────────

export const submitToolOutputs = async (args: {
  projectIds?: number[];
  agentId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
}): Promise<GenerationResult | 'not_found' | 'generation_not_found'> => {
  const pending = pendingGenerations.get(args.generationId);

  if (!pending || pending.agentId !== args.agentId) {
    return 'generation_not_found';
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

  saveTrace({
    traceId: pending.traceId,
    projectId: pending.projectId,
    projectPublicId: pending.projectPublicId,
    agentId: pending.agentId,
    steps: serializeSteps(result.steps as unknown[]),
  }).catch(() => {});
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: result.finishReason,
  }).catch(() => {});

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

  resolveProjectPublicId({ projectId: pending.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'agents.generation.completed',
        projectId: pending.projectId,
        projectPublicId,
        resourceType: 'generation',
        resourceId: args.generationId,
        data: completedResult as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return completedResult;
};
