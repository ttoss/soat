import type { LanguageModel, ModelMessage, Tool, ToolChoice } from 'ai';
import { stepCountIs, streamText } from 'ai';
import createDebug from 'debug';

import { emitEvent } from './eventBus';
import { updateGenerationRecord } from './generations';
import { saveTrace, serializeSteps } from './traces';

const log = createDebug('soat:generation');

// ── Types ─────────────────────────────────────────────────────────────────

export type PendingGeneration = {
  agentId: string;
  projectId: number;
  projectPublicId: string;
  traceId: string;
  parentTraceId: string | null;
  rootTraceId: string | null;
  generationId: string;
  initiatorGenerationId: string | null;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  messages: Array<unknown>;
  resolvedModel: LanguageModel;
  agentConfig: {
    instructions: string | null;
    maxSteps: number;
    toolChoice: unknown;
    stopConditions: unknown;
    activeToolIds: string[] | null;
    stepRules: unknown;
    temperature: number | null;
  };
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string>;
};

export type GenerationResult = {
  id: string;
  traceId: string;
  status: 'completed' | 'requires_action';
  output?: {
    model: string;
    content: string;
    finishReason: string;
  };
  requiredAction?: {
    type: 'submit_tool_outputs';
    toolCalls: Array<{
      id: string;
      toolName: string;
      args: unknown;
    }>;
  };
};

export type TypedAgent = {
  instructions: string | null;
  model: string | null;
  toolIds: unknown;
  maxSteps: unknown;
  toolChoice: unknown;
  stopConditions: unknown;
  activeToolIds: unknown;
  stepRules: unknown;
  boundaryPolicy: unknown;
  temperature: unknown;
  knowledgeConfig: unknown;
  project: { id: unknown; publicId: string };
  aiProvider: { publicId: string };
};

// ── In-Memory Store ───────────────────────────────────────────────────────

export const pendingGenerations = new Map<string, PendingGeneration>();

export const buildAllMessages = (
  instructions: string | null,
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> => {
  if (!instructions) return messages;
  return [{ role: 'system', content: instructions }, ...messages];
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
  log('buildPrepareStep (stream): rules=%o', rules);
  return ({ stepNumber }) => {
    // stepNumber is 0-based (AI SDK), step_rules use 1-indexed steps
    const rule = rules.find((r) => {
      return r.step === stepNumber + 1;
    });
    log(
      'prepareStep (stream): stepNumber=%d (1-indexed=%d) rule=%o',
      stepNumber,
      stepNumber + 1,
      rule
    );
    if (rule?.toolChoice?.type === 'tool' && rule.toolChoice.toolName) {
      log(
        'prepareStep (stream): forcing toolChoice=%s',
        rule.toolChoice.toolName
      );
      return {
        toolChoice: { type: 'tool', toolName: rule.toolChoice.toolName },
        activeTools: [rule.toolChoice.toolName],
      };
    }
    return {};
  };
};

export const runStreamGeneration = (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: string }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  generationId: string;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
}): ReadableStream => {
  const system = args.allMessages.find((m) => {
    return m.role === 'system';
  })?.content;
  const nonSystemMessages = args.allMessages.filter((m) => {
    return m.role !== 'system';
  });
  const prepareStep = buildPrepareStep(args.typedAgent.stepRules);
  log(
    'runStreamGeneration: agentId=%s toolCount=%d stepRulesCount=%d',
    args.agentId,
    Object.keys(args.resolvedTools).length,
    Array.isArray(args.typedAgent.stepRules)
      ? (args.typedAgent.stepRules as unknown[]).length
      : 0
  );
  log('runStreamGeneration: tools=%o', Object.keys(args.resolvedTools));
  const result = streamText({
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
    onFinish: ({ steps, finishReason }) => {
      saveTrace({
        traceId: args.traceId,
        projectId: args.typedAgent.project.id as number,
        projectPublicId: args.typedAgent.project.publicId,
        agentId: args.agentId,
        steps: serializeSteps(steps as unknown[]),
        parentTraceId: args.parentTraceId ?? null,
        rootTraceId: args.rootTraceId ?? null,
      }).catch(() => {});
      updateGenerationRecord({
        publicId: args.generationId,
        status: 'completed',
        completedAt: new Date(),
        stopReason: finishReason,
      }).catch(() => {});
    },
  });
  return result.textStream as unknown as ReadableStream;
};

export const findPendingClientTools = (
  steps: Array<{
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  }>,
  resolvedTools: Record<string, Tool>
): Array<{ toolCallId: string; toolName: string; input: unknown }> => {
  return steps
    .flatMap((step) => {
      return step.toolCalls ?? [];
    })
    .filter((tc) => {
      const resolvedTool = resolvedTools[tc.toolName];
      return resolvedTool && !('execute' in resolvedTool);
    });
};

const storePendingGenerationState = (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  agentId: string;
  typedAgent: TypedAgent;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  allMessages: Array<{ role: string; content: string }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): void => {
  pendingGenerations.set(args.generationId, {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    generationId: args.generationId,
    pendingToolCalls: args.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      };
    }),
    messages: [...args.allMessages, ...args.result.response.messages],
    resolvedModel: args.model,
    agentConfig: {
      instructions: args.typedAgent.instructions,
      maxSteps: (args.typedAgent.maxSteps as number) ?? 20,
      toolChoice: args.typedAgent.toolChoice,
      stopConditions: args.typedAgent.stopConditions,
      activeToolIds: args.typedAgent.activeToolIds as string[] | null,
      stepRules: args.typedAgent.stepRules,
      temperature: args.typedAgent.temperature as number | null,
    },
    resolvedTools: args.resolvedTools,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
  });

  // Persist pending state to DB so it can be recovered after a server restart.
  const pendingState: Record<string, unknown> = {
    pendingToolCalls: args.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      };
    }),
    messages: [...args.allMessages, ...args.result.response.messages],
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    toolContext: args.toolContext ?? null,
    remainingDepth: args.remainingDepth ?? null,
  };
  updateGenerationRecord({
    publicId: args.generationId,
    metadata: { pendingState },
  }).catch(() => {});
};

export const savePendingGeneration = (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  allMessages: Array<{ role: string; content: string }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): GenerationResult => {
  const serializedStepsPending = serializeSteps(args.result.steps as unknown[]);
  saveTrace({
    traceId: args.traceId,
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    agentId: args.agentId,
    steps: serializedStepsPending,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  }).catch(() => {});
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'requires_action',
    lastActivityAt: new Date(),
  }).catch(() => {});

  storePendingGenerationState(args);

  const requiresActionResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'requires_action',
    requiredAction: {
      type: 'submit_tool_outputs',
      toolCalls: args.pendingToolCalls.map((tc) => {
        return {
          id: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input,
        };
      }),
    },
  };

  emitEvent({
    type: 'agents.generation.requires_action',
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: requiresActionResult as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return requiresActionResult;
};

export const buildCompletedGenerationResult = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  result: {
    steps: unknown[];
    response?: { modelId?: string };
    text: string;
    finishReason: string;
  };
  typedAgent: TypedAgent;
  agentId: string;
}): Promise<GenerationResult> => {
  const serializedStepsCompleted = serializeSteps(
    args.result.steps as unknown[]
  );
  await saveTrace({
    traceId: args.traceId,
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    agentId: args.agentId,
    steps: serializedStepsCompleted,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
  });
  updateGenerationRecord({
    publicId: args.generationId,
    status: 'completed',
    completedAt: new Date(),
    stopReason: args.result.finishReason,
  }).catch(() => {});

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model: args.result.response?.modelId ?? args.typedAgent.model ?? '',
      content: args.result.text,
      finishReason: args.result.finishReason,
    },
  };

  emitEvent({
    type: 'agents.generation.completed',
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: completedResult as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return completedResult;
};
