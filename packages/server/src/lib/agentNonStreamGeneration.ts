import type { LanguageModel, ModelMessage, Tool, ToolChoice } from 'ai';
import { generateText, stepCountIs } from 'ai';
import createDebug from 'debug';

import {
  buildCompletedGenerationResult,
  findPendingClientTools,
  type GenerationResult,
  type PendingGeneration,
  savePendingGeneration,
  type TypedAgent,
} from './agentGenerationHelpers';
import {
  fireCompletionSideEffects,
  recordGenerationFailure,
} from './generationLifecycle';
import { toProviderDomainError } from './providerError';

const log = createDebug('soat:generation');

type StepRule = {
  step: number;
  toolChoice?: { type: 'tool'; toolName: string };
};

export const buildPrepareStep = (args: {
  stepRules: unknown;
  logContext: 'stream' | 'non_stream';
}):
  | ((opts: { stepNumber: number }) => {
      toolChoice?: ToolChoice<Record<string, Tool>>;
      activeTools?: string[];
    })
  | undefined => {
  if (!Array.isArray(args.stepRules) || args.stepRules.length === 0) {
    return undefined;
  }

  const rules = args.stepRules as StepRule[];
  log('buildPrepareStep (%s): rules=%o', args.logContext, rules);

  return ({ stepNumber }) => {
    const oneIndexedStep = stepNumber + 1;
    const rule = rules.find((candidate) => {
      return candidate.step === oneIndexedStep;
    });

    log(
      'prepareStep (%s): stepNumber=%d (1-indexed=%d) rule=%o',
      args.logContext,
      stepNumber,
      oneIndexedStep,
      rule
    );

    if (rule?.toolChoice?.type === 'tool' && rule.toolChoice.toolName) {
      log(
        'prepareStep (%s): forcing toolChoice=%s',
        args.logContext,
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

const callGenerateText = async (args: {
  agentId: string;
  model: LanguageModel;
  system: string | undefined;
  nonSystemMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  prepareStep: ReturnType<typeof buildPrepareStep>;
  abortSignal?: AbortSignal;
}) => {
  const hasTools = Object.keys(args.resolvedTools).length > 0;

  try {
    return await generateText({
      model: args.model,
      system: args.system,
      messages: args.nonSystemMessages as ModelMessage[],
      tools: hasTools ? args.resolvedTools : undefined,
      toolChoice:
        (args.typedAgent.toolChoice as
          | 'auto'
          | 'required'
          | { type: 'tool'; toolName: string }
          | undefined) ?? undefined,
      prepareStep: args.prepareStep,
      stopWhen: stepCountIs((args.typedAgent.maxSteps as number) ?? 20),
      temperature: (args.typedAgent.temperature as number) ?? undefined,
      abortSignal: args.abortSignal,
    });
  } catch (error) {
    log(
      'callGenerateText FAILED agentId=%s errorType=%s message=%s stack=%s',
      args.agentId,
      error instanceof Error ? error.constructor.name : typeof error,
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error.stack : ''
    );
    throw toProviderDomainError(error) ?? error;
  }
};

type GenerateTextResult = {
  steps: unknown[];
  response?: { messages?: unknown[]; modelId?: string };
  text: string;
  finishReason: string;
};

const resolveGenerationResult = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  result: GenerateTextResult;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): Promise<GenerationResult> => {
  const pendingToolCalls = findPendingClientTools(
    args.result.steps as Array<{
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
      parentTraceId: args.parentTraceId ?? null,
      rootTraceId: args.rootTraceId ?? null,
      pendingToolCalls,
      allMessages: args.allMessages,
      result: args.result as {
        steps: unknown[];
        response: { messages: unknown[]; modelId?: string };
        text: string;
        finishReason: string;
      },
      model: args.model,
      typedAgent: args.typedAgent,
      agentId: args.agentId,
      resolvedTools: args.resolvedTools,
      toolContext: args.toolContext ?? null,
      remainingDepth: args.remainingDepth ?? null,
    });
  }

  return buildCompletedGenerationResult({
    generationId: args.generationId,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    result: args.result,
    typedAgent: args.typedAgent,
    agentId: args.agentId,
  });
};

export const runNonStreamGeneration = async (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  generationId: string;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  abortSignal?: AbortSignal;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): Promise<GenerationResult> => {
  const system = args.allMessages.find((message) => {
    return message.role === 'system';
  })?.content as string | undefined;

  const nonSystemMessages = args.allMessages.filter((message) => {
    return message.role !== 'system';
  });

  const prepareStep = buildPrepareStep({
    stepRules: args.typedAgent.stepRules,
    logContext: 'non_stream',
  });

  log(
    'runNonStreamGeneration: calling callGenerateText agentId=%s maxSteps=%s',
    args.agentId,
    args.typedAgent.maxSteps
  );

  const callArgs = {
    agentId: args.agentId,
    model: args.model,
    system,
    nonSystemMessages,
    typedAgent: args.typedAgent,
    prepareStep,
    abortSignal: args.abortSignal,
  };

  let result;
  try {
    result = await callGenerateText({
      ...callArgs,
      resolvedTools: args.resolvedTools,
    });
  } catch (error) {
    if (Object.keys(args.resolvedTools).length === 0) {
      throw error;
    }
    log(
      'runNonStreamGeneration: tool call failed, retrying without tools agentId=%s error=%s',
      args.agentId,
      error instanceof Error ? error.message : String(error)
    );
    result = await callGenerateText({ ...callArgs, resolvedTools: {} });
  }

  return resolveGenerationResult({
    ...args,
    result: result as GenerateTextResult,
  });
};

export const runToolOutputsGeneration = async (args: {
  generationId: string;
  pending: PendingGeneration;
  system: string | undefined;
  nonSystemMessages: unknown[];
}): Promise<GenerateTextResult> => {
  try {
    return await generateText({
      model: args.pending.resolvedModel,
      system: args.system,
      messages: args.nonSystemMessages as ModelMessage[],
      tools:
        Object.keys(args.pending.resolvedTools).length > 0
          ? args.pending.resolvedTools
          : undefined,
      prepareStep: buildPrepareStep({
        stepRules: args.pending.agentConfig.stepRules,
        logContext: 'non_stream',
      }),
      stopWhen: stepCountIs(args.pending.agentConfig.maxSteps),
      temperature: args.pending.agentConfig.temperature ?? undefined,
    });
  } catch (error) {
    throw await recordGenerationFailure({
      generationId: args.generationId,
      traceId: args.pending.traceId,
      error: toProviderDomainError(error) ?? error,
    });
  }
};

type ToolOutputsGenerationResult = {
  steps: unknown[];
  response?: { messages?: unknown[]; modelId?: string };
  text: string;
  finishReason: string;
};

const buildTypedAgentFromPending = (pending: PendingGeneration): TypedAgent => {
  return {
    instructions: pending.agentConfig.instructions,
    model: null,
    toolIds: null,
    maxSteps: pending.agentConfig.maxSteps,
    toolChoice: pending.agentConfig.toolChoice,
    stopConditions: pending.agentConfig.stopConditions,
    activeToolIds: pending.agentConfig.activeToolIds,
    stepRules: pending.agentConfig.stepRules,
    boundaryPolicy: null,
    temperature: pending.agentConfig.temperature,
    knowledgeConfig: null,
    project: { id: pending.projectId, publicId: pending.projectPublicId },
    aiProvider: { publicId: '' },
  };
};

export const resolveToolOutputsResult = (args: {
  generationId: string;
  agentId: string;
  pending: PendingGeneration;
  allMessages: unknown[];
  result: ToolOutputsGenerationResult;
}): GenerationResult => {
  const newPendingToolCalls = findPendingClientTools(
    args.result.steps as Array<{
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }>;
    }>,
    args.pending.resolvedTools
  );

  if (newPendingToolCalls.length > 0) {
    log(
      'resolveToolOutputsResult: continuation produced %d new client tool calls generationId=%s',
      newPendingToolCalls.length,
      args.generationId
    );
    return savePendingGeneration({
      generationId: args.generationId,
      traceId: args.pending.traceId,
      parentTraceId: args.pending.parentTraceId,
      rootTraceId: args.pending.rootTraceId,
      pendingToolCalls: newPendingToolCalls,
      allMessages: args.allMessages as Array<{
        role: string;
        content: unknown;
      }>,
      result: args.result as {
        steps: unknown[];
        response: { messages: unknown[]; modelId?: string };
        text: string;
        finishReason: string;
      },
      model: args.pending.resolvedModel,
      typedAgent: buildTypedAgentFromPending(args.pending),
      agentId: args.agentId,
      resolvedTools: args.pending.resolvedTools,
      toolContext: args.pending.toolContext ?? null,
      remainingDepth: null,
    });
  }

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.pending.traceId,
    status: 'completed',
    output: {
      model: args.result.response?.modelId ?? '',
      content: args.result.text,
      finishReason: args.result.finishReason,
      responseMessages: args.result.response?.messages as
        | Array<unknown>
        | undefined,
    },
  };

  fireCompletionSideEffects({
    generationId: args.generationId,
    pending: args.pending,
    result: args.result as { steps: unknown[]; finishReason: string },
    completedResult,
  });

  return completedResult;
};

export const buildToolResultMessages = (args: {
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
  pendingToolCalls: PendingGeneration['pendingToolCalls'];
}) => {
  return args.toolOutputs.map((output) => {
    const pendingTool = args.pendingToolCalls.find((toolCall) => {
      return toolCall.toolCallId === output.toolCallId;
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
