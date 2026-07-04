import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import {
  type GenerationResult,
  type PendingGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import { buildModel } from './agentModel';
import { resolveAgentTools } from './agentToolResolver';
import { getGeneration, updateGenerationRecord } from './generations';
import type { InlineToolDefinition } from './tools';
import { saveTrace } from './traces';

// ── Agent Resolver ────────────────────────────────────────────────────────

export const resolveAgentForGeneration = async (args: {
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

// ── Depth Guard ───────────────────────────────────────────────────────────

export const buildDepthGuardResult = (args: {
  traceId: string;
  projectId: number;
  projectPublicId: string;
  agentId: string;
  generationId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): GenerationResult => {
  saveTrace({
    traceId: args.traceId,
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    agentId: args.agentId,
    steps: [{ type: 'depth_guard', message: 'Maximum call depth reached' }],
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  }).catch(() => {});
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: 'depth_guard',
  }).catch(() => {});
  return {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model: '',
      content: 'Maximum call depth reached',
      finishReason: 'stop',
    },
  };
};

// ── DB Recovery ───────────────────────────────────────────────────────────

type PendingStateDb = {
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  messages: Array<{ role: string; content: string }>;
  steps?: unknown[];
  parentTraceId: string | null;
  rootTraceId: string | null;
  toolContext: Record<string, string> | null;
  remainingDepth: number | null;
};

const buildPendingFromState = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authHeader?: string;
  typedAgent: TypedAgent;
  traceId: string;
  pendingState: PendingStateDb;
}): Promise<PendingGeneration | undefined> => {
  const resolved = await resolveAiProviderSecret({
    aiProviderId: args.typedAgent.aiProvider.publicId,
  });
  if (!resolved) return undefined;

  const model = buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: args.typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  const resolvedTools =
    args.typedAgent.toolIds || args.typedAgent.tools
      ? await resolveAgentTools({
          toolIds: (args.typedAgent.toolIds as string[] | null) ?? [],
          tools: args.typedAgent.tools as InlineToolDefinition[] | null,
          projectId: args.typedAgent.project.id as number,
          projectIds: args.projectIds,
          boundaryPolicy: args.typedAgent.boundaryPolicy,
          authHeader: args.authHeader,
          toolContext: args.pendingState.toolContext ?? undefined,
          remainingDepth: args.pendingState.remainingDepth ?? undefined,
        })
      : {};

  return {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    parentTraceId: args.pendingState.parentTraceId,
    rootTraceId: args.pendingState.rootTraceId,
    generationId: args.generationId,
    pendingToolCalls: args.pendingState.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      };
    }),
    messages: args.pendingState.messages,
    steps: args.pendingState.steps ?? [],
    resolvedModel: model,
    agentConfig: {
      instructions: args.typedAgent.instructions,
      maxSteps: (args.typedAgent.maxSteps as number) ?? 20,
      toolChoice: args.typedAgent.toolChoice,
      stopConditions: args.typedAgent.stopConditions,
      activeToolIds: args.typedAgent.activeToolIds as string[] | null,
      stepRules: args.typedAgent.stepRules,
      temperature: args.typedAgent.temperature as number | null,
      outputSchema: args.typedAgent.outputSchema,
    },
    resolvedTools,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
  };
};

export const recoverPendingFromDb = async (args: {
  generationId: string;
  agentId: string;
  projectIds?: number[];
  authHeader?: string;
}): Promise<PendingGeneration | undefined> => {
  const gen = await getGeneration({ publicId: args.generationId });
  const pendingState = gen?.metadata?.pendingState as
    | PendingStateDb
    | undefined;

  if (!gen || !pendingState || gen.agentId !== args.agentId) {
    return undefined;
  }

  const typedAgent = await resolveAgentForGeneration({
    agentId: args.agentId,
    projectIds: args.projectIds,
  });
  if (!typedAgent) return undefined;

  return buildPendingFromState({
    generationId: args.generationId,
    agentId: args.agentId,
    projectIds: args.projectIds,
    authHeader: args.authHeader,
    typedAgent,
    traceId: gen.traceId,
    pendingState,
  });
};
