import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage, Tool } from 'ai';
import { generateText, stepCountIs } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';

import { db } from '../db';
import {
  buildAllMessages,
  buildCompletedGenerationResult,
  buildDepthGuardResult,
  findPendingClientTools,
  type GenerationResult,
  type PendingGeneration,
  pendingGenerations,
  runStreamGeneration,
  savePendingGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import { buildModel } from './agentModel';
import { resolveAgentTools } from './agentToolResolver';
import { traces } from './agentTraces';
import { resolveProjectPublicId } from './eventBus';

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

// ── Non-Stream Generation ─────────────────────────────────────────────────

const runNonStreamGeneration = async (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: string }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  generationId: string;
  traceId: string;
  agentId: string;
}): Promise<GenerationResult> => {
  const result = await generateText({
    model: args.model,
    messages: args.allMessages as ModelMessage[],
    tools:
      Object.keys(args.resolvedTools).length > 0
        ? args.resolvedTools
        : undefined,
    toolChoice:
      (args.typedAgent.toolChoice as
        | 'auto'
        | 'required'
        | { type: 'tool'; toolName: string }
        | undefined) ?? undefined,
    stopWhen: stepCountIs((args.typedAgent.maxSteps as number) ?? 20),
    temperature: (args.typedAgent.temperature as number) ?? undefined,
  });

  const pendingToolCalls = findPendingClientTools(
    result.steps as Array<{
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }>;
    }>,
    args.resolvedTools
  );

  if (pendingToolCalls.length > 0) {
    return savePendingGeneration({
      generationId: args.generationId,
      traceId: args.traceId,
      pendingToolCalls,
      allMessages: args.allMessages,
      result: result as {
        steps: unknown[];
        response: { messages: unknown[]; modelId?: string };
        text: string;
        finishReason: string;
      },
      model: args.model,
      typedAgent: args.typedAgent,
      agentId: args.agentId,
      resolvedTools: args.resolvedTools,
    });
  }

  return buildCompletedGenerationResult({
    generationId: args.generationId,
    traceId: args.traceId,
    result: result as {
      steps: unknown[];
      response?: { modelId?: string };
      text: string;
      finishReason: string;
    },
    typedAgent: args.typedAgent,
    agentId: args.agentId,
  });
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
  remainingDepth?: number;
  authHeader?: string;
  toolContext?: Record<string, string>;
}): Promise<
  GenerationResult | 'not_found' | 'ai_provider_not_found' | ReadableStream
> => {
  const maxDepth = args.remainingDepth ?? 10;
  const traceId = args.traceId ?? generatePublicId(PUBLIC_ID_PREFIXES.trace);

  if (maxDepth <= 0) {
    return buildDepthGuardResult({
      traceId,
      projectId: args.projectIds?.[0] ?? 0,
      agentId: args.agentId,
    });
  }

  const ctx = await buildGenerationContext({
    agentId: args.agentId,
    projectIds: args.projectIds,
    messages: args.messages,
    authHeader: args.authHeader,
    toolContext: args.toolContext,
  });

  if (ctx === 'not_found' || ctx === 'ai_provider_not_found') return ctx;

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
  });
};

// ── Submit Tool Outputs ───────────────────────────────────────────────────

const buildToolResultMessages = (
  toolOutputs: Array<{ toolCallId: string; output: unknown }>,
  pendingToolCalls: PendingGeneration['pendingToolCalls']
) => {
  return toolOutputs.map((output) => {
    const pendingTool = pendingToolCalls.find((tc) => {
      return tc.toolCallId === output.toolCallId;
    });
    return {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: output.toolCallId,
          toolName: pendingTool?.toolName ?? '',
          output: {
            type: 'text' as const,
            value:
              typeof output.output === 'string'
                ? output.output
                : JSON.stringify(output.output),
          },
        },
      ],
    };
  });
};

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

  const toolResultMessages = buildToolResultMessages(
    args.toolOutputs,
    pending.pendingToolCalls
  );
  const allMessages = [...pending.messages, ...toolResultMessages];

  const result = await generateText({
    model: pending.resolvedModel,
    messages: allMessages as ModelMessage[],
    tools:
      Object.keys(pending.resolvedTools).length > 0
        ? pending.resolvedTools
        : undefined,
    stopWhen: stepCountIs(pending.agentConfig.maxSteps),
    temperature: pending.agentConfig.temperature ?? undefined,
  });

  traces.set(pending.traceId, {
    id: pending.traceId,
    projectId: pending.projectId,
    agentId: pending.agentId,
    status: 'completed',
    createdAt: new Date(),
    steps: result.steps as unknown[],
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

  resolveProjectPublicId({ projectId: pending.projectId }).then(
    (projectPublicId) => {
      import('./eventBus').then(({ emitEvent }) => {
        emitEvent({
          type: 'agents.generation.completed',
          projectId: pending.projectId,
          projectPublicId,
          resourceType: 'generation',
          resourceId: args.generationId,
          data: completedResult as unknown as Record<string, unknown>,
          timestamp: new Date().toISOString(),
        });
      });
    }
  );

  return completedResult;
};
