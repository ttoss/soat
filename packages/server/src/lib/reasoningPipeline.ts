import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { createGenerationRecord, updateGenerationRecord } from './generations';
import {
  MAX_ROUNDS,
  MAX_STEPS,
  MAX_TOTAL_COMPLETIONS,
  REASONING_PIPELINE_TIMEOUT_MS,
  REASONING_STEP_TIMEOUT_MS,
  type ReasoningBranch,
  type ReasoningMessage,
  type ReasoningStep,
} from './reasoning';
import * as reasoningCompletion from './reasoningCompletion';

const log = createDebug('soat:reasoning');

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

type TranscriptEntry = { name: string; text: string };

const renderTranscript = (transcript: TranscriptEntry[]): string => {
  return transcript
    .map((entry) => {
      return `${entry.name}: ${entry.text}`;
    })
    .join('\n');
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
 * `{draft}`, `{steps.<name>}` (concat of that step's turns), `{steps.<name>.last}`
 * (only its final turn), and `{transcript}` (prior turns within the current
 * step — its presence is what turns on the shared, sequential transcript).
 * Unknown tokens are left untouched.
 */
export const resolveTemplate = (args: {
  template: string;
  question: string;
  draft: string;
  stepOutputs: Record<string, string>;
  stepLastOutputs?: Record<string, string>;
  transcript?: TranscriptEntry[];
}): string => {
  return args.template.replace(/\{([\w.]+)\}/g, (match, token: string) => {
    if (token === 'question') return args.question;
    if (token === 'draft') return args.draft;
    if (token === 'transcript') return renderTranscript(args.transcript ?? []);
    if (token.startsWith('steps.')) {
      const rest = token.slice('steps.'.length);
      const lastSuffix = /^(.+)\.last$/.exec(rest);
      if (lastSuffix) return args.stepLastOutputs?.[lastSuffix[1]] ?? '';
      return args.stepOutputs[rest] ?? '';
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
  /** Mutable runtime budget — defence-in-depth beyond write-time validation. */
  budget: { remaining: number };
  /** Epoch ms after which no further completion may start. */
  deadline: number;
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
  if (args.ctx.budget.remaining <= 0) {
    throw new Error('reasoning completion budget exhausted');
  }
  const remainingMs = args.ctx.deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error('reasoning pipeline deadline exceeded');
  }
  args.ctx.budget.remaining -= 1;
  const childGenId = await createChildGenerationRecord(args.ctx);
  try {
    const text = await reasoningCompletion.runReasoningCompletion({
      agentId: args.ctx.agentId,
      projectIds: args.ctx.projectIds,
      aiProviderId: args.aiProviderId,
      model: args.model,
      prompt: args.prompt,
      temperature: args.temperature ?? args.ctx.temperature ?? undefined,
      abortSignal: AbortSignal.timeout(
        Math.min(remainingMs, REASONING_STEP_TIMEOUT_MS)
      ),
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

/** Branches to run: the step's explicit list, or a single implicit branch. */
const resolveBranches = (step: ReasoningStep): ReasoningBranch[] => {
  if (step.branches && step.branches.length > 0) return step.branches;
  return [{}];
};

/**
 * Renders a step's bound output (`{steps.<name>}` and the final answer, if
 * this is the output step). A single-branch step's turns are joined as plain
 * text — there is only one actor, so a name label would be redundant noise in
 * the final answer. A multi-branch step's turns are joined `name: text` so a
 * downstream synthesis step can attribute each turn.
 */
const renderStepOutput = (
  transcript: TranscriptEntry[],
  isSingleBranch: boolean
): string => {
  if (isSingleBranch) {
    return transcript
      .map((entry) => {
        return entry.text;
      })
      .join('\n');
  }
  return renderTranscript(transcript);
};

type StepRunResult = {
  /** Concat of all turns as `name: text`, for `{steps.<name>}`. */
  text: string;
  /** Only the chronologically final turn, for `{steps.<name>.last}`. */
  lastText: string;
  ran: number;
  dropped: number;
  halted: boolean;
};

type BranchTurnResult =
  | { status: 'ok'; text: string }
  | { status: 'halted'; text: string }
  | { status: 'failed' };

/** Resolves this branch's prompt template, falling back to the step's. */
const resolveBranchTemplate = (args: {
  branch: ReasoningBranch;
  step: ReasoningStep;
}): string => {
  return args.branch.prompt ?? args.step.prompt ?? '';
};

/** Resolves this branch's model config, falling back to the step's defaults. */
const resolveBranchModelConfig = (args: {
  branch: ReasoningBranch;
  step: ReasoningStep;
}): { aiProviderId?: string; model?: string; temperature?: number } => {
  const { branch, step } = args;
  return {
    aiProviderId: branch.aiProviderId ?? step.aiProviderId,
    model: branch.model ?? step.model,
    temperature: branch.temperature ?? step.temperature,
  };
};

/** True when a single-branch step's turn matches its `haltIfEquals`. */
const isHaltMatch = (args: {
  isSingleBranch: boolean;
  haltIfEquals?: string;
  text: string;
}): boolean => {
  if (!args.isSingleBranch || args.haltIfEquals === undefined) return false;
  return args.text.trim() === args.haltIfEquals.trim();
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Runs a single branch's turn: resolves its prompt (seeing prior turns via
 * `{transcript}` if referenced), runs the completion, and pushes the turn onto
 * the step's live transcript. `haltIfEquals` only applies on a single-branch
 * step (enforced at write time).
 */
const runBranchTurn = async (args: {
  ctx: PipelineContext;
  step: ReasoningStep;
  branch: ReasoningBranch;
  round: number;
  isSingleBranch: boolean;
  stepOutputs: Record<string, string>;
  stepLastOutputs: Record<string, string>;
  transcript: TranscriptEntry[];
}): Promise<BranchTurnResult> => {
  const { ctx, step, branch } = args;
  const label = branch.name ?? step.name;
  const prompt = resolveTemplate({
    template: resolveBranchTemplate({ branch, step }),
    question: ctx.question,
    draft: ctx.draft,
    stepOutputs: args.stepOutputs,
    stepLastOutputs: args.stepLastOutputs,
    transcript: args.transcript,
  });
  try {
    const text = await runCompletion({
      ctx,
      stepLabel: label,
      prompt,
      round: args.round,
      ...resolveBranchModelConfig({ branch, step }),
    });
    args.transcript.push({ name: label, text });
    const halted = isHaltMatch({
      isSingleBranch: args.isSingleBranch,
      haltIfEquals: step.haltIfEquals,
      text,
    });
    return halted ? { status: 'halted', text } : { status: 'ok', text };
  } catch (error) {
    log(
      'runStep: step=%s branch=%s round=%d failed error=%s',
      step.name,
      label,
      args.round,
      errorMessage(error)
    );
    return { status: 'failed' };
  }
};

/**
 * Runs a step's `branches` over `rounds`. Branches whose prompt (or the
 * step's, used as fallback) references `{transcript}` see every prior turn
 * within the step, so they run round-major/branch-order sequentially; without
 * that token the branches are independent samples (still executed in order
 * here, since nothing depends on their relative timing).
 */
const runStep = async (args: {
  ctx: PipelineContext;
  step: ReasoningStep;
  stepOutputs: Record<string, string>;
  stepLastOutputs: Record<string, string>;
}): Promise<StepRunResult> => {
  const { ctx, step } = args;
  const branches = resolveBranches(step);
  const rounds = clamp(step.rounds ?? 1, 1, MAX_ROUNDS);
  const isSingleBranch = branches.length === 1;
  const transcript: TranscriptEntry[] = [];
  let dropped = 0;
  let lastText = '';

  for (let round = 0; round < rounds; round++) {
    for (const branch of branches) {
      const result = await runBranchTurn({
        ctx,
        step,
        branch,
        round,
        isSingleBranch,
        stepOutputs: args.stepOutputs,
        stepLastOutputs: args.stepLastOutputs,
        transcript,
      });
      if (result.status === 'failed') {
        dropped += 1;
        continue;
      }
      lastText = result.text;
      if (result.status === 'halted') {
        return {
          text: renderStepOutput(transcript, isSingleBranch),
          lastText,
          ran: transcript.length,
          dropped,
          halted: true,
        };
      }
    }
  }

  return {
    text: renderStepOutput(transcript, isSingleBranch),
    lastText,
    ran: transcript.length,
    dropped,
    halted: false,
  };
};

const resolveOutputIndex = (steps: ReasoningStep[]): number => {
  const explicit = steps.findIndex((step) => {
    return step.output === true;
  });
  return explicit >= 0 ? explicit : steps.length - 1;
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
    budget: { remaining: MAX_TOTAL_COMPLETIONS },
    deadline: Date.now() + REASONING_PIPELINE_TIMEOUT_MS,
  };
  const outputIndex = resolveOutputIndex(steps);
  const stepOutputs: Record<string, string> = {};
  const stepLastOutputs: Record<string, string> = {};
  let stepsRun = 0;
  let dropped = 0;

  const fallback = (reason: PipelineOutcome['reason']): PipelineOutcome => {
    return { text: args.draft, applied: false, reason, stepsRun, dropped };
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const result = await runStep({ ctx, step, stepOutputs, stepLastOutputs });
    dropped += result.dropped;
    if (result.halted) return fallback('halted');
    if (result.ran === 0) {
      if (i === outputIndex) return fallback('output_failed');
      continue;
    }
    stepsRun += result.ran;
    stepOutputs[step.name] = result.text;
    stepLastOutputs[step.name] = result.lastText;
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
