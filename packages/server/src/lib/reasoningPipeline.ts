import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { createGenerationRecord, updateGenerationRecord } from './generations';
import {
  emitReasoningFallbackEvent,
  MAX_FANOUT,
  MAX_ROUNDS,
  MAX_STEPS,
  type PerspectiveConfig,
  type ReasoningConfig,
  type ReasoningMessage,
  type ReasoningStep,
  recordReasoningSummary,
} from './reasoning';
import * as reasoningCompletion from './reasoningCompletion';

const log = createDebug('soat:reasoning');

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

/**
 * Flattens the transcript into the question string a reasoning step sees.
 * Only plain-text user/assistant turns are included.
 */
export const formatQuestion = (messages: ReasoningMessage[]): string => {
  return messages
    .filter((message) => {
      return (
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        (message.content as string).trim().length > 0
      );
    })
    .map((message) => {
      return `${message.role}: ${message.content as string}`;
    })
    .join('\n');
};

/**
 * Resolves the allowlisted template tokens in a step prompt: `{question}`,
 * `{draft}`, and `{steps.<name>}` for any earlier step output. Unknown tokens
 * are left untouched.
 */
export const resolveTemplate = (args: {
  template: string;
  question: string;
  draft: string;
  stepOutputs: Record<string, string>;
}): string => {
  return args.template.replace(/\{([\w.]+)\}/g, (match, token: string) => {
    if (token === 'question') return args.question;
    if (token === 'draft') return args.draft;
    if (token.startsWith('steps.')) {
      const name = token.slice('steps.'.length);
      return args.stepOutputs[name] ?? '';
    }
    return match;
  });
};

export type PipelineOutcome = {
  text: string;
  applied: boolean;
  reason: 'completed' | 'halted' | 'all_failed' | 'output_failed';
  stepsRun: number;
  dropped: number;
};

type PipelineContext = {
  agentId: string;
  projectIds?: number[];
  projectId?: number;
  traceId?: string;
  initiatorGenerationId?: string;
  question: string;
  draft: string;
  temperature?: number | null;
};

const createChildGenerationRecord = async (
  ctx: PipelineContext
): Promise<string | undefined> => {
  if (!ctx.traceId || ctx.projectId === undefined) return undefined;
  const childGenId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
  try {
    await createGenerationRecord({
      publicId: childGenId,
      projectId: ctx.projectId,
      agentId: ctx.agentId,
      traceId: ctx.traceId,
      initiatorGenerationId: ctx.initiatorGenerationId,
    });
    return childGenId;
  } catch (error) {
    log(
      'reasoningPipeline: failed to create child generation record error=%s',
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
};

/**
 * Runs a single completion against the reasoning primitive, recording a child
 * generation for observability. Throws on provider failure (callers decide how
 * to degrade).
 */
const runCompletion = async (args: {
  ctx: PipelineContext;
  stepLabel: string;
  prompt: string;
  aiProviderId?: string;
  model?: string;
  temperature?: number | null;
  round?: number;
}): Promise<string> => {
  const childGenId = await createChildGenerationRecord(args.ctx);
  try {
    const text = await reasoningCompletion.runReasoningCompletion({
      agentId: args.ctx.agentId,
      projectIds: args.ctx.projectIds,
      aiProviderId: args.aiProviderId,
      model: args.model,
      prompt: args.prompt,
      temperature: args.temperature ?? args.ctx.temperature ?? undefined,
    });
    if (childGenId) {
      void updateGenerationRecord({
        publicId: childGenId,
        status: 'completed',
        completedAt: new Date(),
        stopReason: 'stop',
        metadata: {
          reasoning: { step: args.stepLabel, round: args.round, output: text },
        },
      });
    }
    return text;
  } catch (error) {
    if (childGenId) {
      void updateGenerationRecord({
        publicId: childGenId,
        status: 'failed',
        completedAt: new Date(),
      });
    }
    throw error;
  }
};

type TranscriptEntry = { name: string; text: string };

const buildPerspectiveList = (step: ReasoningStep): PerspectiveConfig[] => {
  if (step.perspectives && step.perspectives.length > 0) {
    return step.perspectives.slice(0, MAX_FANOUT);
  }
  return Array.from(
    { length: clamp(step.count ?? 2, 2, MAX_FANOUT) },
    (_unused, index) => {
      return { name: `Perspective ${index + 1}` };
    }
  );
};

const renderTranscript = (transcript: TranscriptEntry[]): string => {
  return transcript
    .map((entry) => {
      return `${entry.name}: ${entry.text}`;
    })
    .join('\n');
};

const buildPerspectivePrompt = (args: {
  name: string;
  base: string;
  transcript: TranscriptEntry[];
}): string => {
  if (args.transcript.length === 0)
    return `You are ${args.name}.\n${args.base}`;
  return `You are ${args.name}.\n${args.base}\n\nPrevious perspectives:\n${renderTranscript(
    args.transcript
  )}`;
};

/**
 * Runs a fanout step: N perspectives over `rounds`, each seeing prior turns.
 * Returns the joined transcript and the count of failed (dropped) turns.
 */
const runFanout = async (args: {
  ctx: PipelineContext;
  step: ReasoningStep;
  stepOutputs: Record<string, string>;
}): Promise<{ text: string; dropped: number; ran: number }> => {
  const perspectives = buildPerspectiveList(args.step);
  const rounds = clamp(args.step.rounds ?? 1, 1, MAX_ROUNDS);
  const transcript: TranscriptEntry[] = [];
  let dropped = 0;

  for (let round = 0; round < rounds; round++) {
    for (const perspective of perspectives) {
      const name = perspective.name ?? 'Perspective';
      const base = resolveTemplate({
        template: perspective.prompt ?? args.step.prompt,
        question: args.ctx.question,
        draft: args.ctx.draft,
        stepOutputs: args.stepOutputs,
      });
      try {
        const text = await runCompletion({
          ctx: args.ctx,
          stepLabel: name,
          prompt: buildPerspectivePrompt({ name, base, transcript }),
          aiProviderId: perspective.aiProviderId,
          model: perspective.model,
          round,
        });
        transcript.push({ name, text });
      } catch (error) {
        dropped += 1;
        log(
          'runFanout: perspective=%s round=%d failed error=%s',
          name,
          round,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  return {
    text: renderTranscript(transcript),
    dropped,
    ran: transcript.length,
  };
};

const resolveOutputIndex = (steps: ReasoningStep[]): number => {
  const explicit = steps.findIndex((step) => {
    return step.output === true;
  });
  return explicit >= 0 ? explicit : steps.length - 1;
};

type StepResult =
  | { status: 'ok'; text: string }
  | { status: 'halted' }
  | { status: 'failed' };

const runCompletionStep = async (args: {
  ctx: PipelineContext;
  step: ReasoningStep;
  stepOutputs: Record<string, string>;
}): Promise<StepResult> => {
  const { ctx, step } = args;
  let text: string;
  try {
    text = await runCompletion({
      ctx,
      stepLabel: step.name,
      prompt: resolveTemplate({
        template: step.prompt,
        question: ctx.question,
        draft: ctx.draft,
        stepOutputs: args.stepOutputs,
      }),
      aiProviderId: step.aiProviderId,
      model: step.model,
      temperature: step.temperature,
    });
  } catch (error) {
    log(
      'runCompletionStep: step=%s failed error=%s',
      step.name,
      error instanceof Error ? error.message : String(error)
    );
    return { status: 'failed' };
  }
  if (
    step.haltIfEquals !== undefined &&
    text.trim() === step.haltIfEquals.trim()
  ) {
    return { status: 'halted' };
  }
  return { status: 'ok', text };
};

/**
 * Executes a reasoning pipeline over a base draft and returns the final text.
 * Pure meta-cognition: every step is a side-effect-free completion, and any
 * failure degrades to the draft rather than failing the generation.
 */
export const runReasoningPipeline = async (args: {
  agentId: string;
  projectIds?: number[];
  projectId?: number;
  traceId?: string;
  initiatorGenerationId?: string;
  steps: ReasoningStep[];
  question: string;
  draft: string;
  temperature?: number | null;
}): Promise<PipelineOutcome> => {
  const steps = args.steps.slice(0, MAX_STEPS);
  const ctx: PipelineContext = {
    agentId: args.agentId,
    projectIds: args.projectIds,
    projectId: args.projectId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId,
    question: args.question,
    draft: args.draft,
    temperature: args.temperature,
  };
  const outputIndex = resolveOutputIndex(steps);
  const stepOutputs: Record<string, string> = {};
  let stepsRun = 0;
  let dropped = 0;

  const fallback = (reason: PipelineOutcome['reason']): PipelineOutcome => {
    return { text: args.draft, applied: false, reason, stepsRun, dropped };
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.kind === 'fanout') {
      const fanout = await runFanout({ ctx, step, stepOutputs });
      dropped += fanout.dropped;
      stepsRun += fanout.ran;
      stepOutputs[step.name] = fanout.text;
      continue;
    }

    const result = await runCompletionStep({ ctx, step, stepOutputs });
    if (result.status === 'halted') return fallback('halted');
    if (result.status === 'failed') {
      dropped += 1;
      if (i === outputIndex) return fallback('output_failed');
      continue;
    }
    stepsRun += 1;
    stepOutputs[step.name] = result.text;
  }

  const finalText = stepOutputs[steps[outputIndex]?.name];
  if (finalText && finalText.trim().length > 0) {
    return {
      text: finalText,
      applied: true,
      reason: 'completed',
      stepsRun,
      dropped,
    };
  }
  return fallback(stepsRun === 0 ? 'all_failed' : 'output_failed');
};

type PipelineResult = {
  text: string;
  response?: { messages?: Array<unknown>; modelId?: string };
};

/**
 * Pipeline hook: applies `mode: pipeline` reasoning to a completed raw
 * generation result in place — the trace, completion event, and API response
 * are all built from the final text afterwards. No-op for any other mode.
 */
export const maybeApplyPipelineToResult = async (args: {
  reasoningConfig?: ReasoningConfig | null;
  agentId: string;
  generationId: string;
  traceId?: string;
  projectId?: number;
  projectPublicId?: string;
  messages: ReasoningMessage[];
  result: PipelineResult;
  temperature?: number | null;
}): Promise<void> => {
  const config = args.reasoningConfig;
  if (
    config?.mode !== 'pipeline' ||
    !Array.isArray(config.steps) ||
    config.steps.length === 0 ||
    args.result.text.trim().length === 0
  ) {
    return;
  }

  const outcome = await runReasoningPipeline({
    agentId: args.agentId,
    steps: config.steps,
    question: formatQuestion(args.messages),
    draft: args.result.text,
    temperature: args.temperature,
    traceId: args.traceId,
    projectId: args.projectId,
    initiatorGenerationId: args.generationId,
  });

  if (outcome.applied) {
    args.result.text = outcome.text;
    // The draft's responseMessages no longer match the final text — drop them
    // so conversation replay does not resurrect the draft.
    if (args.result.response) {
      args.result.response = { ...args.result.response, messages: undefined };
    }
  }

  emitReasoningFallbackEvent({
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    generationId: args.generationId,
    mode: 'pipeline',
    reason: outcome.reason,
    data: { stepsRun: outcome.stepsRun, dropped: outcome.dropped },
  });

  void recordReasoningSummary({
    generationId: args.generationId,
    summary: {
      mode: 'pipeline',
      applied: outcome.applied,
      reason: outcome.reason,
      stepsRun: outcome.stepsRun,
      dropped: outcome.dropped,
      fallback: !outcome.applied,
    },
  });
};

/** Applies orchestrated reasoning (currently `pipeline` mode) in place. */
export const applyOrchestration = async (args: {
  reasoningConfig?: ReasoningConfig | null;
  agentId: string;
  generationId: string;
  traceId?: string;
  projectId?: number;
  projectPublicId?: string;
  messages: ReasoningMessage[];
  result: PipelineResult;
  temperature?: number | null;
}): Promise<void> => {
  await maybeApplyPipelineToResult(args);
};
