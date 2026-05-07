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
  nonSystemMessages: Array<{ role: string; content: string }>;
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
    if (!hasTools) {
      log(
        'Generation failed (no tools to fall back from) agentId=%s: %s',
        args.agentId,
        error
      );
      throw error;
    }

    log(
      'Generation with tools failed, retrying without tools agentId=%s model=%s: %s',
      args.agentId,
      args.typedAgent.model,
      error
    );

    return generateText({
      model: args.model,
      system: args.system,
      messages: args.nonSystemMessages as ModelMessage[],
      stopWhen: stepCountIs(1),
      temperature: (args.typedAgent.temperature as number) ?? undefined,
      abortSignal: args.abortSignal,
    });
  }
};

export const runNonStreamGeneration = async (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: string }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  generationId: string;
  traceId: string;
  agentId: string;
  abortSignal?: AbortSignal;
}): Promise<GenerationResult> => {
  const system = args.allMessages.find((message) => {
    return message.role === 'system';
  })?.content;

  const nonSystemMessages = args.allMessages.filter((message) => {
    return message.role !== 'system';
  });

  const prepareStep = buildPrepareStep({
    stepRules: args.typedAgent.stepRules,
    logContext: 'non_stream',
  });

  const result = await callGenerateText({
    agentId: args.agentId,
    model: args.model,
    system,
    nonSystemMessages,
    resolvedTools: args.resolvedTools,
    typedAgent: args.typedAgent,
    prepareStep,
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
