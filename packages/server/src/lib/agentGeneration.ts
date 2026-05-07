import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage, Tool, ToolChoice } from 'ai';
import { generateText, stepCountIs } from 'ai';
import createDebug from 'debug';
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
import { saveTrace, serializeSteps } from './agentTraces';
import { resolveProjectPublicId } from './eventBus';
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

// ── Step Rules ────────────────────────────────────────────────────────────

type StepRule = {
  step: number;
  toolChoice?: { type: 'tool'; toolName: string };
};

const buildPrepareStep = (
  stepRules: unknown
):
  | ((opts: { stepNumber: number }) => {
      toolChoice?: ToolChoice<Record<string, Tool>>;
      activeTools?: string[];
    })
  | undefined => {
  if (!Array.isArray(stepRules) || stepRules.length === 0) return undefined;
  const rules = stepRules as StepRule[];
  log('buildPrepareStep: rules=%o', rules);
  return ({ stepNumber }) => {
    // stepNumber is 0-based (AI SDK), step_rules use 1-indexed steps
    const rule = rules.find((r) => {
      return r.step === stepNumber + 1;
    });
    log(
      'prepareStep: stepNumber=%d (1-indexed=%d) rule=%o',
      stepNumber,
      stepNumber + 1,
      rule
    );
    if (rule?.toolChoice?.type === 'tool' && rule.toolChoice.toolName) {
      log('prepareStep: forcing toolChoice=%o', rule.toolChoice.toolName);
      return {
        toolChoice: { type: 'tool', toolName: rule.toolChoice.toolName },
        activeTools: [rule.toolChoice.toolName],
      };
    }
    return {};
  };
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
  abortSignal?: AbortSignal;
}): Promise<GenerationResult> => {
  const system = args.allMessages.find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = args.allMessages.filter((m) => {
    return m.role !== 'system';
  });
  const prepareStep = buildPrepareStep(args.typedAgent.stepRules);
  const result = await generateText({
    model: args.model,
    system,
    messages: nonSystemMessages as ModelMessage[],
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
    prepareStep,
    stopWhen: stepCountIs((args.typedAgent.maxSteps as number) ?? 20),
    temperature: (args.typedAgent.temperature as number) ?? undefined,
    abortSignal: args.abortSignal,
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
    prepareStep: buildPrepareStep(pending.agentConfig.stepRules),
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
