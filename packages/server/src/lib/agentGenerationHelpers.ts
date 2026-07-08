import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  Tool,
  ToolChoice,
} from 'ai';
import { isStepCount, streamText } from 'ai';
import createDebug from 'debug';

import { emitEvent } from './eventBus';
import { updateGenerationRecord } from './generations';
import { saveTrace, serializeSteps } from './traces';
import { recordGenerationUsage } from './usage';

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
  steps: unknown[];
  resolvedModel: LanguageModel;
  agentConfig: {
    instructions: string | null;
    maxSteps: number;
    toolChoice: unknown;
    stopConditions: unknown;
    activeToolIds: string[] | null;
    stepRules: unknown;
    temperature: number | null;
    outputSchema: unknown;
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
    /** Full AI SDK response messages from this generation (tool calls, tool results, final text). */
    responseMessages?: Array<unknown>;
    /** Structured object matching the agent's `outputSchema`, when configured. */
    object?: unknown;
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
  tools: unknown;
  maxSteps: unknown;
  toolChoice: unknown;
  stopConditions: unknown;
  activeToolIds: unknown;
  stepRules: unknown;
  boundaryPolicy: unknown;
  temperature: unknown;
  knowledgeConfig: unknown;
  outputSchema: unknown;
  project: { id: unknown; publicId: string };
  aiProvider: { publicId: string };
};

// ── In-Memory Store ───────────────────────────────────────────────────────

export const pendingGenerations = new Map<string, PendingGeneration>();

export const buildAllMessages = (
  instructions: string | null,
  messages: Array<{ role: string; content: unknown }>
): Array<{ role: string; content: unknown }> => {
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
  allMessages: Array<{ role: string; content: unknown }>;
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
  })?.content as string | undefined;
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
    instructions: system,
    messages: nonSystemMessages as ModelMessage[],
    tools:
      Object.keys(args.resolvedTools).length > 0
        ? args.resolvedTools
        : undefined,
    toolChoice:
      (args.typedAgent.toolChoice as
        'auto' | 'required' | { type: 'tool'; toolName: string } | undefined) ??
      undefined,
    prepareStep,
    stopWhen: isStepCount((args.typedAgent.maxSteps as number) ?? 20),
    temperature: (args.typedAgent.temperature as number) ?? undefined,
    onEnd: ({ steps, finishReason, usage }) => {
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
      // recordGenerationUsage never rejects (it catches internally), so `void`
      // marks the intentional fire-and-forget without an extra no-op handler.
      void recordGenerationUsage({
        generationId: args.generationId,
        model: args.typedAgent.model ?? '',
        usage,
      });
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
  allMessages: Array<{ role: string; content: unknown }>;
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
    steps: serializeSteps(args.result.steps),
    resolvedModel: args.model,
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
    steps: serializeSteps(args.result.steps),
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
  allMessages: Array<{ role: string; content: unknown }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): GenerationResult => {
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
    response?: { modelId?: string; messages?: Array<unknown> };
    text: string;
    finishReason: string;
    object?: unknown;
    usage?: LanguageModelUsage;
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

  const model = args.result.response?.modelId ?? args.typedAgent.model ?? '';

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model,
      content: args.result.text,
      finishReason: args.result.finishReason,
      responseMessages: args.result.response?.messages,
      ...(args.result.object !== undefined
        ? { object: args.result.object }
        : {}),
    },
  };

  await recordGenerationUsage({
    generationId: args.generationId,
    model,
    usage: args.result.usage,
  });

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
