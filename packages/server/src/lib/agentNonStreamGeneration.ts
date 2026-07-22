/* eslint-disable max-lines */
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  Tool,
  ToolChoice,
} from 'ai';
import { generateText, isStepCount } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import {
  gatePendingClientTools,
  type SynthesizedClientResult,
} from './agentClientToolGuardrail';
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
import { applyToolOutputMapping } from './jsonLogicMapping';
import { buildStructuredOutput } from './outputSchema';
import { toProviderDomainError } from './providerError';
import { serializeSteps } from './traces';

// Bounds the server-side auto-resume loop for the "every pending client call was
// gated" case: a model that re-proposes a blocked/tripped client tool every turn
// would otherwise resume forever. Past the cap the generation completes with the
// last turn as its terminal state.
const MAX_CLIENT_GATE_RESUMES = 12;

type PendingClientCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

// Tool-result messages for client calls the guardrail gate did NOT release
// (class D / tripwire / pending_approval). They share the assistant turn with
// the released calls, so they must be present before the loop resumes.
const buildSyntheticToolResultMessages = (
  synthesizedResults: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
  }>
): Array<{ role: 'tool'; content: unknown }> => {
  return synthesizedResults.map((entry) => {
    return {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          output: {
            type: 'text' as const,
            value:
              typeof entry.output === 'string'
                ? entry.output
                : JSON.stringify(entry.output),
          },
        },
      ],
    };
  });
};

// Runs the guardrail gate over the client calls a turn produced. Returns null
// when the turn proposed no client calls at all (the common completed path);
// otherwise the released-vs-synthesized partition.
const partitionClientCalls = async (args: {
  steps: unknown[];
  resolvedTools: Record<string, Tool>;
}): Promise<{
  released: PendingClientCall[];
  synthesizedResults: SynthesizedClientResult[];
} | null> => {
  const pending = findPendingClientTools(
    args.steps as Array<{
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }>;
    }>,
    args.resolvedTools
  );
  if (pending.length === 0) return null;

  const { released, synthesizedResults } = await gatePendingClientTools({
    pendingToolCalls: pending,
    resolvedTools: args.resolvedTools,
  });
  return { released, synthesizedResults };
};

export { buildSyntheticToolResultMessages };

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
      instructions: args.system,
      messages: args.nonSystemMessages as ModelMessage[],
      tools: hasTools ? args.resolvedTools : undefined,
      toolChoice:
        (args.typedAgent.toolChoice as
          | 'auto'
          | 'required'
          | { type: 'tool'; toolName: string }
          | undefined) ?? undefined,
      prepareStep: args.prepareStep,
      stopWhen: isStepCount((args.typedAgent.maxSteps as number) ?? 20),
      temperature: (args.typedAgent.temperature as number) ?? undefined,
      abortSignal: args.abortSignal,
      output: buildStructuredOutput(args.typedAgent.outputSchema),
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
  output?: unknown;
  usage?: LanguageModelUsage;
};

type ClientCallPartition = {
  released: PendingClientCall[];
  synthesizedResults: SynthesizedClientResult[];
};

// Params for suspending/resuming a turn whose partition still needs settling —
// the fields that differ between the initial turn (real typedAgent/model) and a
// continuation turn (rebuilt from the pending state).
type SettleSaveArgs = {
  typedAgent: TypedAgent;
  model: LanguageModel;
  allMessages: Array<{ role: string; content: unknown }>;
  result: {
    steps: unknown[];
    response: { messages: unknown[]; modelId?: string };
    text: string;
    finishReason: string;
  };
  remainingDepth?: number | null;
};

// Enacts a non-null partition: suspend and hand the released calls to the client
// (their synthesized siblings merged in on submit), or — when nothing was
// released — inject the synthesized results and resume so the model can react.
const settlePartition = (args: {
  pending: PendingGeneration;
  partition: ClientCallPartition;
  save: SettleSaveArgs;
  resumeCount: number;
}): Promise<GenerationResult> => {
  if (args.partition.released.length > 0) {
    return Promise.resolve(
      savePendingGeneration({
        generationId: args.pending.generationId,
        traceId: args.pending.traceId,
        parentTraceId: args.pending.parentTraceId,
        rootTraceId: args.pending.rootTraceId,
        pendingToolCalls: args.partition.released,
        syntheticToolResults: args.partition.synthesizedResults,
        allMessages: args.save.allMessages,
        result: args.save.result,
        model: args.save.model,
        typedAgent: args.save.typedAgent,
        agentId: args.pending.agentId,
        resolvedTools: args.pending.resolvedTools,
        toolContext: args.pending.toolContext ?? null,
        remainingDepth: args.save.remainingDepth ?? null,
      })
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutually recursive with resolveToolOutputsResult
  return resumeWithSyntheticResults({
    pending: args.pending,
    synthesizedResults: args.partition.synthesizedResults,
    resumeCount: args.resumeCount,
  });
};

// The transient pending state for the initial turn's all-gated resume: no
// released calls, carrying the just-run steps (so the trace keeps them) and the
// agent config the continuation loop needs.
const buildInitialResumePending = (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  responseMessages: unknown[];
  initialSteps: unknown[];
  toolContext?: Record<string, string> | null;
}): PendingGeneration => {
  return {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    generationId: args.generationId,
    pendingToolCalls: [],
    syntheticToolResults: [],
    messages: [...args.allMessages, ...args.responseMessages],
    steps: serializeSteps(args.initialSteps),
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
    toolContext: args.toolContext ?? undefined,
  };
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
  const partition = await partitionClientCalls({
    steps: args.result.steps,
    resolvedTools: args.resolvedTools,
  });

  if (partition) {
    const resultForPending = args.result as SettleSaveArgs['result'];
    return settlePartition({
      pending: buildInitialResumePending({
        generationId: args.generationId,
        traceId: args.traceId,
        parentTraceId: args.parentTraceId,
        rootTraceId: args.rootTraceId,
        allMessages: args.allMessages,
        resolvedTools: args.resolvedTools,
        model: args.model,
        typedAgent: args.typedAgent,
        agentId: args.agentId,
        responseMessages: resultForPending.response.messages,
        initialSteps: args.result.steps,
        toolContext: args.toolContext,
      }),
      partition,
      save: {
        typedAgent: args.typedAgent,
        model: args.model,
        allMessages: args.allMessages,
        result: resultForPending,
        remainingDepth: args.remainingDepth,
      },
      resumeCount: 0,
    });
  }

  return buildCompletedGenerationResult({
    generationId: args.generationId,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId ?? null,
    rootTraceId: args.rootTraceId ?? null,
    result: {
      steps: args.result.steps,
      finishReason: args.result.finishReason,
      text: args.result.text,
      response: args.result.response,
      object: args.typedAgent.outputSchema ? args.result.output : undefined,
      usage: args.result.usage,
    },
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
      instructions: args.system,
      messages: args.nonSystemMessages as ModelMessage[],
      tools:
        Object.keys(args.pending.resolvedTools).length > 0
          ? args.pending.resolvedTools
          : undefined,
      prepareStep: buildPrepareStep({
        stepRules: args.pending.agentConfig.stepRules,
        logContext: 'non_stream',
      }),
      stopWhen: isStepCount(args.pending.agentConfig.maxSteps),
      temperature: args.pending.agentConfig.temperature ?? undefined,
      output: buildStructuredOutput(args.pending.agentConfig.outputSchema),
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
  output?: unknown;
  usage?: LanguageModelUsage;
};

const buildTypedAgentFromPending = (pending: PendingGeneration): TypedAgent => {
  return {
    instructions: pending.agentConfig.instructions,
    model: null,
    toolIds: null,
    tools: null,
    maxSteps: pending.agentConfig.maxSteps,
    toolChoice: pending.agentConfig.toolChoice,
    stopConditions: pending.agentConfig.stopConditions,
    activeToolIds: pending.agentConfig.activeToolIds,
    stepRules: pending.agentConfig.stepRules,
    boundaryPolicy: null,
    temperature: pending.agentConfig.temperature,
    knowledgeConfig: null,
    outputSchema: pending.agentConfig.outputSchema,
    project: { id: pending.projectId, publicId: pending.projectPublicId },
    aiProvider: { publicId: '' },
  };
};

// Builds the completed result for a continuation turn and fires its side effects
// (trace, usage, completion event) — the terminal path once no client calls
// remain (or the resume cap is hit).
const completeContinuation = (args: {
  generationId: string;
  pending: PendingGeneration;
  result: ToolOutputsGenerationResult;
}): GenerationResult => {
  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.pending.traceId,
    status: 'completed',
    output: {
      model: args.result.response?.modelId ?? '',
      content: args.result.text,
      finishReason: args.result.finishReason,
      responseMessages: args.result.response?.messages as
        Array<unknown> | undefined,
      ...(args.pending.agentConfig.outputSchema
        ? { object: args.result.output }
        : {}),
    },
  };

  fireCompletionSideEffects({
    generationId: args.generationId,
    pending: args.pending,
    result: args.result as {
      steps: unknown[];
      finishReason: string;
      response?: { modelId?: string };
      usage?: LanguageModelUsage;
    },
    completedResult,
  });

  return completedResult;
};

export const resolveToolOutputsResult = async (args: {
  generationId: string;
  agentId: string;
  pending: PendingGeneration;
  allMessages: unknown[];
  result: ToolOutputsGenerationResult;
  resumeCount?: number;
}): Promise<GenerationResult> => {
  const resumeCount = args.resumeCount ?? 0;
  const partition = await partitionClientCalls({
    steps: args.result.steps,
    resolvedTools: args.pending.resolvedTools,
  });

  // All-gated with the resume budget spent → stop looping and complete.
  const capReached =
    partition !== null &&
    partition.released.length === 0 &&
    resumeCount >= MAX_CLIENT_GATE_RESUMES;
  if (capReached) {
    log(
      'resolveToolOutputsResult: client-gate resume cap reached generationId=%s — completing',
      args.generationId
    );
  }

  if (partition && !capReached) {
    // Fold this turn's assistant message and steps into the pending state so a
    // resume (or a later suspend) carries the full history.
    const nextPending: PendingGeneration = {
      ...args.pending,
      messages: [
        ...(args.allMessages as Array<{ role: string; content: unknown }>),
        ...(args.result.response?.messages ?? []),
      ],
      steps: [
        ...(args.pending.steps ?? []),
        ...serializeSteps(args.result.steps),
      ],
    };
    return settlePartition({
      pending: nextPending,
      partition,
      save: {
        typedAgent: buildTypedAgentFromPending(args.pending),
        model: args.pending.resolvedModel,
        allMessages: args.allMessages as Array<{
          role: string;
          content: unknown;
        }>,
        result: args.result as SettleSaveArgs['result'],
        remainingDepth: null,
      },
      resumeCount,
    });
  }

  return completeContinuation({
    generationId: args.generationId,
    pending: args.pending,
    result: args.result,
  });
};

/**
 * Re-runs the model after every proposed client call was gated (nothing went to
 * the client), injecting the synthesized tool results so the assistant turn is
 * complete before the provider is called again. Recurses through
 * {@link resolveToolOutputsResult}, which re-gates any further client calls (the
 * recursion is bounded by `MAX_CLIENT_GATE_RESUMES`).
 */
const resumeWithSyntheticResults = async (args: {
  pending: PendingGeneration;
  synthesizedResults: SynthesizedClientResult[];
  resumeCount: number;
}): Promise<GenerationResult> => {
  const synthMessages = buildSyntheticToolResultMessages(
    args.synthesizedResults
  );
  const allMessages = [...args.pending.messages, ...synthMessages];
  const system = (
    args.pending.messages as Array<{ role: string; content: string }>
  ).find((message) => {
    return message.role === 'system';
  })?.content;
  const nonSystemMessages = allMessages.filter((message) => {
    return (message as { role?: string }).role !== 'system';
  });

  const result = await runToolOutputsGeneration({
    generationId: args.pending.generationId,
    pending: args.pending,
    system,
    nonSystemMessages,
  });

  return resolveToolOutputsResult({
    generationId: args.pending.generationId,
    agentId: args.pending.agentId,
    pending: args.pending,
    allMessages,
    result,
    resumeCount: args.resumeCount + 1,
  });
};

/**
 * Client tools are materialized directly from submitted outputs, bypassing
 * the AI-SDK resolver where `outputMapping` is normally applied — so it's
 * looked up here by name, scoped to the generation's project.
 */
export const loadOutputMappingsByToolName = async (args: {
  projectId: number;
  pendingToolCalls: PendingGeneration['pendingToolCalls'];
}): Promise<Record<string, Record<string, unknown> | null>> => {
  const toolNames = [
    ...new Set(
      args.pendingToolCalls.map((toolCall) => {
        return toolCall.toolName;
      })
    ),
  ];
  if (toolNames.length === 0) return {};
  const tools = await db.Tool.findAll({
    where: { projectId: args.projectId, name: toolNames },
  });
  const result: Record<string, Record<string, unknown> | null> = {};
  for (const toolInstance of tools) {
    result[toolInstance.name] = toolInstance.outputMapping as Record<
      string,
      unknown
    > | null;
  }
  return result;
};

export const buildToolResultMessages = (args: {
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
  pendingToolCalls: PendingGeneration['pendingToolCalls'];
  // Client tools bypass the resolver's execute wrapping, so their
  // output_mapping (if any) is applied here instead, keyed by tool name.
  outputMappingsByToolName?: Record<
    string,
    Record<string, unknown> | null | undefined
  >;
}) => {
  return args.toolOutputs.map((output) => {
    const pendingTool = args.pendingToolCalls.find((toolCall) => {
      return toolCall.toolCallId === output.toolCallId;
    });
    const toolName = pendingTool?.toolName ?? '';
    const outputMapping = args.outputMappingsByToolName?.[toolName];
    const mappedOutput = outputMapping
      ? applyToolOutputMapping(outputMapping, output.output)
      : output.output;

    return {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: output.toolCallId,
          toolName,
          output: {
            type: 'text' as const,
            value:
              typeof mappedOutput === 'string'
                ? mappedOutput
                : JSON.stringify(mappedOutput),
          },
        },
      ],
    };
  });
};
