import type { LanguageModel, LanguageModelUsage, ModelMessage, Tool } from 'ai';
import { generateText } from 'ai';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { gatePendingClientTools } from './agentClientToolGuardrail';
import {
  buildCompletedGenerationResult,
  findPendingClientTools,
  savePendingGeneration,
  servedAiProviderId,
} from './agentGenerationHelpers';
import {
  type AgentRunResult,
  type ClientToolCall,
  type ClientToolResult,
  fromAgentConfig,
  type GenerationResult,
  type PendingGeneration,
  toAgentConfig,
  type TypedAgent,
} from './agentGenerationTypes';
import { modelCallSettings } from './agentModelSettings';
import {
  buildPrepareStep,
  normalizeToolChoice,
  resolveAgentStepRuleToolIdToName,
  resolveStepRuleToolIdToName,
  type TurnToolChoice,
} from './agentStepRules';
import { isTurnBudgetSpent, resolveStopWhen } from './agentStopConditions';
import {
  fireCompletionSideEffects,
  meterContinuationSegment,
  meterTurnSegment,
  recordContinuationFailure,
} from './generationLifecycle';
import { applyToolOutputMapping } from './jsonLogicMapping';
import {
  collectSystemInstructions,
  type Instructions,
  withoutSystemMessages,
} from './modelMessages';
import {
  routedAiProviderId,
  routedMaxRetries,
  servedModelName,
} from './modelRouteExecutor';
import { buildStructuredOutput } from './outputSchema';
import { toProviderDomainError } from './providerError';
import {
  findTextEncodedToolCall,
  textEncodedToolCallError,
} from './textEncodedToolCall';
import { saveTrace, serializeSteps } from './traces';
import {
  addUsage,
  carrySpentUsage,
  reportedModelOfSteps,
  sumStepUsage,
} from './turnSpend';

// Bounds the auto-resume loop: a model re-proposing a blocked client tool every
// turn would otherwise resume forever.
const MAX_CLIENT_GATE_RESUMES = 12;

const log = createDebug('soat:generation');

/**
 * One `tool` message carrying a tool call's result, in the AI SDK's shape.
 *
 * Both message builders in this file — the one for results the client
 * submitted and the one for results the guardrail gate synthesized — produce
 * exactly this; they differed only in where the output comes from and whether
 * an `output_mapping` is applied to it first.
 */
const buildToolResultMessage = (result: ClientToolResult) => {
  return {
    role: 'tool' as const,
    content: [
      {
        type: 'tool-result' as const,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: {
          type: 'text' as const,
          value:
            typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output),
        },
      },
    ],
  };
};

// Tool-result messages for client calls the guardrail gate did NOT release
// (class D / tripwire / pending_approval). They share the assistant turn with
// the released calls, so they must be present before the loop resumes.
const buildSyntheticToolResultMessages = (
  synthesizedResults: ClientToolResult[]
): Array<{ role: 'tool'; content: unknown }> => {
  return synthesizedResults.map(buildToolResultMessage);
};

// Runs the guardrail gate over the client calls a turn produced. Returns null
// when the turn proposed no client calls at all (the common completed path);
// otherwise the released-vs-synthesized partition.
const partitionClientCalls = async (args: {
  steps: unknown[];
  resolvedTools: Record<string, Tool>;
}): Promise<ClientCallPartition | null> => {
  const pending = findPendingClientTools(
    args.steps as Array<{ toolCalls: ClientToolCall[] }>,
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

const callGenerateText = async (args: {
  agentId: string;
  model: LanguageModel;
  system: Instructions | undefined;
  nonSystemMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  toolChoice: TurnToolChoice;
  prepareStep: ReturnType<typeof buildPrepareStep>;
  abortSignal?: AbortSignal;
  onStepEnd: (step: unknown) => void;
}) => {
  const hasTools = Object.keys(args.resolvedTools).length > 0;

  try {
    return await generateText({
      model: args.model,
      instructions: args.system,
      messages: args.nonSystemMessages as ModelMessage[],
      tools: hasTools ? args.resolvedTools : undefined,
      toolChoice: args.toolChoice,
      prepareStep: args.prepareStep,
      stopWhen: resolveStopWhen(args.typedAgent),
      ...modelCallSettings(args.typedAgent),
      abortSignal: args.abortSignal,
      // The route config is the only retry authority for a routed model; a
      // non-routed model keeps the SDK default.
      maxRetries: routedMaxRetries(args.model),
      output: buildStructuredOutput(args.typedAgent.outputSchema),
      onStepEnd: args.onStepEnd,
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

type ClientCallPartition = {
  released: ClientToolCall[];
  synthesizedResults: ClientToolResult[];
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
    response: { modelId?: string };
    responseMessages: unknown[];
    text: string;
    finishReason: string;
    usage?: LanguageModelUsage;
  };
  /** Steps the turn spent before `result` — empty on its first segment. */
  priorSteps?: unknown[];
  /** Trailing `allMessages` the turn produced before `result`. */
  priorTurnMessageCount?: number;
  remainingDepth?: number | null;
};

// Enacts a non-null partition: suspend and hand the released calls to the client
// (their synthesized siblings merged in on submit), or — when nothing was
// released — inject the synthesized results and resume so the model can react.
// Either way the segment that proposed the calls ends here, so it is metered
// before the turn is handed back or continues.
const settlePartition = async (args: {
  pending: PendingGeneration;
  partition: ClientCallPartition;
  save: SettleSaveArgs;
  resumeCount: number;
}): Promise<GenerationResult> => {
  await meterTurnSegment({
    generationId: args.pending.generationId,
    model: args.save.model,
    reportedModelId: args.save.result.response.modelId,
    usage: args.save.result.usage,
    stepsAlreadySpent: args.save.priorSteps?.length ?? 0,
    turn: {
      steps: args.save.result.steps,
      finishReason: args.save.result.finishReason,
      maxSteps: args.save.typedAgent.maxSteps,
      outcome: 'ok',
    },
  });
  if (args.partition.released.length > 0) {
    return savePendingGeneration({
      generationId: args.pending.generationId,
      traceId: args.pending.traceId,
      parentTraceId: args.pending.parentTraceId,
      rootTraceId: args.pending.rootTraceId,
      pendingToolCalls: args.partition.released,
      syntheticToolResults: args.partition.synthesizedResults,
      allMessages: args.save.allMessages,
      result: args.save.result,
      priorSteps: args.save.priorSteps,
      priorTurnMessageCount: args.save.priorTurnMessageCount,
      model: args.save.model,
      typedAgent: args.save.typedAgent,
      agentId: args.pending.agentId,
      resolvedTools: args.pending.resolvedTools,
      toolsAuthHeader: args.pending.toolsAuthHeader,
      toolContext: args.pending.toolContext ?? null,
      remainingDepth: args.save.remainingDepth ?? null,
    });
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
  toolsAuthHeader: string | undefined;
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
    turnMessageCount: args.responseMessages.length,
    steps: serializeSteps(args.initialSteps),
    resolvedModel: args.model,
    aiProviderId: servedAiProviderId({
      model: args.model,
      typedAgent: args.typedAgent,
    }),
    agentConfig: toAgentConfig(args.typedAgent),
    resolvedTools: args.resolvedTools,
    toolsAuthHeader: args.toolsAuthHeader,
    initiatorGenerationId: null,
    projectPublicId: args.typedAgent.project.publicId,
    toolContext: args.toolContext ?? undefined,
  };
};

type AbandonedSpend = {
  abandoned?: LanguageModelUsage;
  /** The model id the abandoned attempt's provider answered with. */
  reportedModelId?: string;
};

/**
 * Pauses the initial turn on the client calls it proposed — or, when the gate
 * released none, resumes it with their synthesized results. `null` when the
 * turn proposed no client call, so the caller completes it. Shared by the
 * streamed and unstreamed paths: a turn pauses the same way however it ran.
 */
export const settleInitialClientCalls = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  toolsAuthHeader: string | undefined;
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  result: SettleSaveArgs['result'];
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): Promise<GenerationResult | null> => {
  const partition = await partitionClientCalls({
    steps: args.result.steps,
    resolvedTools: args.resolvedTools,
  });
  if (!partition) return null;

  return settlePartition({
    pending: buildInitialResumePending({
      generationId: args.generationId,
      traceId: args.traceId,
      parentTraceId: args.parentTraceId,
      rootTraceId: args.rootTraceId,
      allMessages: args.allMessages,
      resolvedTools: args.resolvedTools,
      toolsAuthHeader: args.toolsAuthHeader,
      model: args.model,
      typedAgent: args.typedAgent,
      agentId: args.agentId,
      responseMessages: args.result.responseMessages,
      initialSteps: args.result.steps,
      toolContext: args.toolContext,
    }),
    partition,
    save: {
      typedAgent: args.typedAgent,
      model: args.model,
      allMessages: args.allMessages,
      result: args.result,
      remainingDepth: args.remainingDepth,
    },
    resumeCount: 0,
  });
};

const resolveGenerationResult = async (args: {
  generationId: string;
  traceId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  toolsAuthHeader: string | undefined;
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  result: AgentRunResult;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): Promise<GenerationResult> => {
  const paused = await settleInitialClientCalls({
    ...args,
    result: {
      steps: args.result.steps,
      response: args.result.response,
      responseMessages: args.result.responseMessages,
      text: args.result.text,
      finishReason: args.result.finishReason,
      usage: args.result.usage,
    },
  });
  if (paused) return paused;

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
      responseMessages: args.result.responseMessages,
      object: args.typedAgent.outputSchema ? args.result.output : undefined,
      usage: args.result.usage,
    },
    typedAgent: args.typedAgent,
    agentId: args.agentId,
    model: args.model,
    toolNames: Object.keys(args.resolvedTools),
  });
};

const callWithToolFallback = async (args: {
  callArgs: Omit<Parameters<typeof callGenerateText>[0], 'resolvedTools'>;
  resolvedTools: Record<string, Tool>;
  ranSteps: unknown[];
  /** What an attempt the fallback abandoned spent; the provider billed it. */
  spend: AbandonedSpend;
}) => {
  try {
    return await callGenerateText({
      ...args.callArgs,
      resolvedTools: args.resolvedTools,
    });
  } catch (error) {
    if (Object.keys(args.resolvedTools).length === 0) {
      throw error;
    }
    // The fallback is for a provider that chokes on our tool *definitions*. A
    // schema violation is the model's output, so retrying without tools would
    // burn a call to hit the same schema — or worse, succeed, answering without
    // the tool the agent was required to use.
    if (
      error instanceof DomainError &&
      error.code === 'OUTPUT_SCHEMA_VALIDATION_FAILED'
    ) {
      throw error;
    }
    log(
      'runNonStreamGeneration: tool call failed, retrying without tools agentId=%s error=%s',
      args.callArgs.agentId,
      error instanceof Error ? error.message : String(error)
    );
    // The retry replaces the abandoned attempt, as its result does on success.
    args.spend.abandoned = sumStepUsage(args.ranSteps);
    args.spend.reportedModelId = reportedModelOfSteps(args.ranSteps);
    args.ranSteps.splice(0);
    return callGenerateText({ ...args.callArgs, resolvedTools: {} });
  }
};

/**
 * {@link resolveGenerationResult} on the turn's whole spend: its calls plus any
 * attempt the tool fallback abandoned. A refusal after the calls completed — a
 * text-encoded tool call, a gate on the client calls it proposed — carries that
 * spend to the failure, since the provider billed it.
 */
const resolveSpentGenerationResult = async (
  args: Parameters<typeof resolveGenerationResult>[0] & {
    abandoned: LanguageModelUsage | undefined;
  }
): Promise<GenerationResult> => {
  const { result, abandoned, ...rest } = args;
  const usage = addUsage(result.usage, abandoned);
  try {
    return await resolveGenerationResult({
      ...rest,
      result: {
        steps: result.steps,
        response: result.response,
        responseMessages: result.responseMessages,
        text: result.text,
        finishReason: result.finishReason,
        // A getter, as on the SDK's result: a turn that paused has no output,
        // and reading one throws.
        get output() {
          return result.output;
        },
        usage,
      },
    });
  } catch (error) {
    throw carrySpentUsage({
      error,
      usage,
      reportedModelId: result.response.modelId,
    });
  }
};

export const runNonStreamGeneration = async (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: unknown }>;
  resolvedTools: Record<string, Tool>;
  toolsAuthHeader: string | undefined;
  typedAgent: TypedAgent;
  toolChoice: TurnToolChoice;
  generationId: string;
  traceId: string;
  agentId: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  abortSignal?: AbortSignal;
  toolContext?: Record<string, string> | null;
  remainingDepth?: number | null;
}): Promise<GenerationResult> => {
  const system = collectSystemInstructions(args.allMessages);
  const nonSystemMessages = withoutSystemMessages(args.allMessages);
  const prepareStep = buildPrepareStep({
    stepRules: args.typedAgent.stepRules,
    logContext: 'non_stream',
    toolIdToName: await resolveAgentStepRuleToolIdToName(args.typedAgent),
    promptCaching: args.typedAgent.promptCaching,
  });

  log(
    'runNonStreamGeneration: calling callGenerateText agentId=%s maxSteps=%s',
    args.agentId,
    args.typedAgent.maxSteps
  );

  // `generateText` discards its steps when it throws — a final answer that
  // fails `output_schema` included — so each is kept as it finishes.
  const ranSteps: unknown[] = [];
  const callArgs = {
    agentId: args.agentId,
    model: args.model,
    system,
    nonSystemMessages,
    typedAgent: args.typedAgent,
    toolChoice: args.toolChoice,
    prepareStep,
    abortSignal: args.abortSignal,
    onStepEnd: (step: unknown) => {
      ranSteps.push(step);
    },
  };

  const spend: AbandonedSpend = {};
  let result;
  try {
    result = await callWithToolFallback({
      callArgs,
      resolvedTools: args.resolvedTools,
      ranSteps,
      spend,
    });
  } catch (error) {
    if (ranSteps.length > 0) {
      await Promise.allSettled([
        saveTrace({
          traceId: args.traceId,
          projectId: args.typedAgent.project.id as number,
          projectPublicId: args.typedAgent.project.publicId,
          agentId: args.agentId,
          generationId: args.generationId,
          steps: serializeSteps(ranSteps),
          parentTraceId: args.parentTraceId ?? null,
          rootTraceId: args.rootTraceId ?? null,
        }),
      ]);
    }
    throw carrySpentUsage({
      error,
      usage: addUsage(spend.abandoned, sumStepUsage(ranSteps)),
      reportedModelId: reportedModelOfSteps(ranSteps) ?? spend.reportedModelId,
    });
  }

  return resolveSpentGenerationResult({
    ...args,
    result: result as AgentRunResult,
    abandoned: spend.abandoned,
  });
};

/**
 * The result of a turn whose step budget ran out at the pause: no model call,
 * nothing new to record. `tool-calls` is the finish reason the exhausted turn
 * actually had — the steps it spent all ended in one — and it is what
 * `resolveStopReason` reads as `max_steps` once the turn's whole step count is
 * weighed against the budget.
 */
const exhaustedTurnResult = (): AgentRunResult => {
  return {
    steps: [],
    response: { modelId: '' },
    responseMessages: [],
    text: '',
    finishReason: 'tool-calls',
  };
};

export const runToolOutputsGeneration = async (args: {
  generationId: string;
  pending: PendingGeneration;
  system: Instructions | undefined;
  nonSystemMessages: unknown[];
}): Promise<AgentRunResult> => {
  // A resume continues the turn that paused, so it inherits that turn's spent
  // steps rather than starting a fresh budget.
  const stepsAlreadySpent = args.pending.steps?.length ?? 0;
  if (
    isTurnBudgetSpent({
      maxSteps: args.pending.agentConfig.maxSteps,
      stepsAlreadySpent,
    })
  ) {
    log(
      'runToolOutputsGeneration: turn budget spent generationId=%s steps=%d',
      args.generationId,
      stepsAlreadySpent
    );
    return exhaustedTurnResult();
  }

  const toolIdToName = await resolveStepRuleToolIdToName({
    stepRules: args.pending.agentConfig.stepRules,
    projectId: args.pending.projectId,
  });
  const ranSteps: unknown[] = [];
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
        toolIdToName,
        stepsAlreadySpent,
        promptCaching: args.pending.agentConfig.promptCaching,
      }),
      // The turn is the agent's on both sides of the pause. What keeps a
      // forcing value from demanding the same tool forever is the budget above,
      // not a rewrite of the choice the author declared.
      toolChoice: normalizeToolChoice(args.pending.agentConfig.toolChoice),
      stopWhen: resolveStopWhen({
        ...args.pending.agentConfig,
        stepsAlreadySpent,
      }),
      ...modelCallSettings(args.pending.agentConfig),
      maxRetries: routedMaxRetries(args.pending.resolvedModel),
      output: buildStructuredOutput(args.pending.agentConfig.outputSchema),
      onStepEnd: (step) => {
        ranSteps.push(step);
      },
    });
  } catch (error) {
    throw await recordContinuationFailure({
      generationId: args.generationId,
      pending: args.pending,
      steps: ranSteps,
      error: toProviderDomainError(error) ?? error,
    });
  }
};

// Builds the completed result for a continuation turn and fires its side effects
// (trace, usage, completion event) — the terminal path once no client calls
// remain (or the resume cap is hit).
const completeContinuation = async (args: {
  generationId: string;
  pending: PendingGeneration;
  result: AgentRunResult;
  /** Every message the turn produced, across all its segments. */
  turnMessages: unknown[];
}): Promise<GenerationResult> => {
  // A continuation ends on model text too, so a call written out as text is no
  // more an answer here than on the initial turn. Failing before
  // `fireCompletionSideEffects` is what keeps the generation off `completed`.
  const textEncodedToolCall = args.pending.agentConfig.outputSchema
    ? null
    : findTextEncodedToolCall({
        text: args.result.text,
        toolNames: Object.keys(args.pending.resolvedTools),
      });
  if (textEncodedToolCall) {
    throw await recordContinuationFailure({
      generationId: args.generationId,
      pending: args.pending,
      steps: args.result.steps,
      error: textEncodedToolCallError(textEncodedToolCall),
    });
  }

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.pending.traceId,
    status: 'completed',
    // The route's chosen target where this turn was routed; otherwise the pin
    // frozen when the turn paused, so a continuation reports the provider the
    // paused turn resolved rather than whatever the agent points at now.
    aiProviderId:
      routedAiProviderId(args.pending.resolvedModel) ??
      args.pending.aiProviderId ??
      null,
    output: {
      model: servedModelName({
        model: args.pending.resolvedModel,
        reportedModelId: args.result.response.modelId,
      }),
      content: args.result.text,
      finishReason: args.result.finishReason,
      responseMessages: args.turnMessages,
      ...(args.pending.agentConfig.outputSchema
        ? { object: args.result.output }
        : {}),
    },
  };

  // Awaited, as the initial turn's is: the segments before this one were
  // metered when they paused, so the caller reads every call's usage on return.
  await meterContinuationSegment(args);
  fireCompletionSideEffects({
    generationId: args.generationId,
    pending: args.pending,
    result: args.result,
  });

  return completedResult;
};

// The messages the turn produced before this segment: what the pause froze,
// plus the tool results injected to resume it.
const priorTurnMessages = (args: {
  pending: PendingGeneration;
  allMessages: unknown[];
}): unknown[] => {
  const count =
    (args.pending.turnMessageCount ?? 0) +
    args.allMessages.length -
    args.pending.messages.length;
  return args.allMessages.slice(args.allMessages.length - count);
};

export const resolveToolOutputsResult = async (args: {
  generationId: string;
  agentId: string;
  pending: PendingGeneration;
  allMessages: unknown[];
  result: AgentRunResult;
  resumeCount?: number;
}): Promise<GenerationResult> => {
  const resumeCount = args.resumeCount ?? 0;
  const priorSteps = args.pending.steps ?? [];
  const priorMessages = priorTurnMessages(args);
  let partition: ClientCallPartition | null;
  try {
    partition = await partitionClientCalls({
      steps: args.result.steps,
      resolvedTools: args.pending.resolvedTools,
    });
  } catch (error) {
    // The calls the gate refused were already billed, as on the initial turn.
    throw await recordContinuationFailure({
      generationId: args.generationId,
      pending: args.pending,
      steps: args.result.steps,
      error,
    });
  }

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
        ...args.result.responseMessages,
      ],
      turnMessageCount:
        priorMessages.length + args.result.responseMessages.length,
      steps: [...priorSteps, ...serializeSteps(args.result.steps)],
    };
    return settlePartition({
      pending: nextPending,
      partition,
      save: {
        typedAgent: fromAgentConfig(args.pending),
        model: args.pending.resolvedModel,
        allMessages: args.allMessages as Array<{
          role: string;
          content: unknown;
        }>,
        result: args.result as SettleSaveArgs['result'],
        priorSteps,
        priorTurnMessageCount: priorMessages.length,
        remainingDepth: null,
      },
      resumeCount,
    });
  }

  return completeContinuation({
    generationId: args.generationId,
    pending: args.pending,
    result: args.result,
    turnMessages: [...priorMessages, ...args.result.responseMessages],
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
  synthesizedResults: ClientToolResult[];
  resumeCount: number;
}): Promise<GenerationResult> => {
  const synthMessages = buildSyntheticToolResultMessages(
    args.synthesizedResults
  );
  const allMessages = [...args.pending.messages, ...synthMessages];
  const system = collectSystemInstructions(args.pending.messages);
  const nonSystemMessages = withoutSystemMessages(allMessages);

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

    return buildToolResultMessage({
      toolCallId: output.toolCallId,
      toolName,
      output: outputMapping
        ? applyToolOutputMapping({ outputMapping, rawResult: output.output })
        : output.output,
    });
  });
};
