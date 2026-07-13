import createDebug from 'debug';

import * as discussionCompletion from './discussionCompletion';
import { renderTemplate } from './templating';

const log = createDebug('soat:discussions');

/**
 * Hard caps for a discussion. These bound the cost of a deliberation — a
 * discussion is pure meta-cognition, never a workflow engine (see
 * `orchestrationEngine.ts` for that layer).
 */
export const MAX_PARTICIPANTS = 5;
export const MAX_ROUNDS = 3;
export const MAX_STEPS = 8;
export const MAX_TOTAL_COMPLETIONS = 24;

/**
 * Latency bounds. A turn or the whole run could otherwise hang on a slow
 * provider; each completion is capped and the run shares an overall deadline.
 */
export const DISCUSSION_TURN_TIMEOUT_MS = 60_000;
export const DISCUSSION_TIMEOUT_MS = 120_000;

export type DiscussionEffort = 'low' | 'medium' | 'high';

/** A single participant within a deliberation step. */
export type DiscussionBranch = {
  /** Label used for transcript/attribution; falls back to the step name. */
  name?: string;
  /** Falls back to the step-level `prompt` when omitted. */
  prompt?: string;
  aiProviderId?: string;
  model?: string;
  temperature?: number;
  effort?: DiscussionEffort;
};

export type DiscussionStep = {
  /** Unique, human-readable step name; referenced as `${steps.<name>}`. Must not contain '.'. */
  name: string;
  /** Prompt template — required unless every branch supplies its own. */
  prompt?: string;
  /** Omit for a single implicit branch. 1–5 entries. */
  branches?: DiscussionBranch[];
  /** Rounds of branch turns (default 1, max 3). >1 requires a `${transcript}` reference. */
  rounds?: number;
  /** Step-level defaults for branches that omit their own. */
  aiProviderId?: string;
  model?: string;
  temperature?: number;
  effort?: DiscussionEffort;
  /** Marks the step whose output is the final answer (else the last step). */
  output?: boolean;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

/** A single recorded turn, used to persist an attributed transcript. */
export type DiscussionTurn = {
  step: string;
  round: number;
  name: string;
  text: string;
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
 * Resolves the allowlisted template tokens in a step prompt through the shared
 * string-template engine: `${topic}`, `${steps.<name>}` (concat of that step's
 * turns), `${steps.<name>.last}` (only its final turn), and `${transcript}`
 * (prior turns within the current step — its presence is what turns on the
 * shared, sequential transcript). Unknown namespaces have no resolver, so their
 * tokens are left untouched.
 */
export const resolveTemplate = (args: {
  template: string;
  topic: string;
  stepOutputs: Record<string, string>;
  stepLastOutputs?: Record<string, string>;
  transcript?: TranscriptEntry[];
}): string => {
  return renderTemplate(args.template, {
    resolvers: {
      topic: () => {
        return args.topic;
      },
      transcript: () => {
        return renderTranscript(args.transcript ?? []);
      },
      steps: (path) => {
        const lastSuffix = /^(.+)\.last$/.exec(path);
        if (lastSuffix) return args.stepLastOutputs?.[lastSuffix[1]] ?? '';
        return args.stepOutputs[path] ?? '';
      },
    },
  }).output;
};

export type DiscussionOutcome = {
  text: string;
  applied: boolean;
  reason: 'completed' | 'all_failed' | 'output_failed';
  stepsRun: number;
  dropped: number;
  turns: DiscussionTurn[];
};

type EngineContext = {
  projectId: number;
  defaultAiProviderId: string;
  defaultModel?: string | null;
  topic: string;
  temperature?: number | null;
  /** Mutable runtime budget — defence-in-depth beyond write-time validation. */
  budget: { remaining: number };
  /** Epoch ms after which no further completion may start. */
  deadline: number;
};

const runTurn = async (args: {
  ctx: EngineContext;
  prompt: string;
  aiProviderId?: string;
  model?: string;
  temperature?: number | null;
  effort?: DiscussionEffort;
}): Promise<string> => {
  if (args.ctx.budget.remaining <= 0) {
    throw new Error('discussion completion budget exhausted');
  }
  const remainingMs = args.ctx.deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error('discussion deadline exceeded');
  }
  args.ctx.budget.remaining -= 1;
  return discussionCompletion.runDiscussionCompletion({
    projectId: args.ctx.projectId,
    aiProviderId: args.aiProviderId ?? args.ctx.defaultAiProviderId,
    model: args.model ?? args.ctx.defaultModel ?? undefined,
    prompt: args.prompt,
    temperature: args.temperature ?? args.ctx.temperature ?? undefined,
    effort: args.effort,
    abortSignal: AbortSignal.timeout(
      Math.min(remainingMs, DISCUSSION_TURN_TIMEOUT_MS)
    ),
  });
};

const resolveBranches = (step: DiscussionStep): DiscussionBranch[] => {
  if (step.branches && step.branches.length > 0) return step.branches;
  return [{}];
};

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
  text: string;
  lastText: string;
  ran: number;
  dropped: number;
  turns: DiscussionTurn[];
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const resolveBranchConfig = (args: {
  branch: DiscussionBranch;
  step: DiscussionStep;
}): {
  aiProviderId?: string;
  model?: string;
  temperature?: number;
  effort?: DiscussionEffort;
} => {
  const { branch, step } = args;
  return {
    aiProviderId: branch.aiProviderId ?? step.aiProviderId,
    model: branch.model ?? step.model,
    temperature: branch.temperature ?? step.temperature,
    effort: branch.effort ?? step.effort,
  };
};

/**
 * Runs a step's `branches` over `rounds`. Branches whose prompt (or the step's,
 * used as fallback) references `${transcript}` see every prior turn within the
 * step, so they run round-major/branch-order sequentially; without that token
 * the branches are independent samples.
 */
const runStep = async (args: {
  ctx: EngineContext;
  step: DiscussionStep;
  stepOutputs: Record<string, string>;
  stepLastOutputs: Record<string, string>;
}): Promise<StepRunResult> => {
  const { ctx, step } = args;
  const branches = resolveBranches(step);
  const rounds = clamp(step.rounds ?? 1, 1, MAX_ROUNDS);
  const isSingleBranch = branches.length === 1;
  const transcript: TranscriptEntry[] = [];
  const turns: DiscussionTurn[] = [];
  let dropped = 0;
  let lastText = '';

  for (let round = 0; round < rounds; round++) {
    for (const branch of branches) {
      const label = branch.name ?? step.name;
      const prompt = resolveTemplate({
        template: branch.prompt ?? step.prompt ?? '',
        topic: ctx.topic,
        stepOutputs: args.stepOutputs,
        stepLastOutputs: args.stepLastOutputs,
        transcript,
      });
      try {
        const text = await runTurn({
          ctx,
          prompt,
          ...resolveBranchConfig({ branch, step }),
        });
        transcript.push({ name: label, text });
        turns.push({ step: step.name, round, name: label, text });
        lastText = text;
      } catch (error) {
        log(
          'runStep: step=%s branch=%s round=%d failed error=%s',
          step.name,
          label,
          round,
          errorMessage(error)
        );
        dropped += 1;
      }
    }
  }

  return {
    text: renderStepOutput(transcript, isSingleBranch),
    lastText,
    ran: transcript.length,
    dropped,
    turns,
  };
};

const resolveOutputIndex = (steps: DiscussionStep[]): number => {
  const explicit = steps.findIndex((step) => {
    return step.output === true;
  });
  return explicit >= 0 ? explicit : steps.length - 1;
};

/**
 * Executes a discussion over its steps and returns the synthesized outcome plus
 * every attributed turn (for transcript persistence). Pure meta-cognition: each
 * turn is a side-effect-free completion, and any failure degrades to the last
 * successful turn rather than failing the run.
 */
export const runDiscussionPipeline = async (args: {
  projectId: number;
  defaultAiProviderId: string;
  defaultModel?: string | null;
  steps: DiscussionStep[];
  topic: string;
  temperature?: number | null;
}): Promise<DiscussionOutcome> => {
  const steps = args.steps.slice(0, MAX_STEPS);
  const ctx: EngineContext = {
    projectId: args.projectId,
    defaultAiProviderId: args.defaultAiProviderId,
    defaultModel: args.defaultModel,
    topic: args.topic,
    temperature: args.temperature,
    budget: { remaining: MAX_TOTAL_COMPLETIONS },
    deadline: Date.now() + DISCUSSION_TIMEOUT_MS,
  };
  const outputIndex = resolveOutputIndex(steps);
  const stepOutputs: Record<string, string> = {};
  const stepLastOutputs: Record<string, string> = {};
  const allTurns: DiscussionTurn[] = [];
  let stepsRun = 0;
  let dropped = 0;

  const fallback = (reason: DiscussionOutcome['reason']): DiscussionOutcome => {
    // Degrade to the last successful turn as the outcome, if any.
    const last = allTurns.length > 0 ? allTurns[allTurns.length - 1].text : '';
    return {
      text: last,
      applied: false,
      reason,
      stepsRun,
      dropped,
      turns: allTurns,
    };
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const result = await runStep({ ctx, step, stepOutputs, stepLastOutputs });
    dropped += result.dropped;
    allTurns.push(...result.turns);
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
      turns: allTurns,
    };
  }
  return fallback(stepsRun === 0 ? 'all_failed' : 'output_failed');
};
