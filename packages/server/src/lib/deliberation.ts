import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { createGenerationRecord, updateGenerationRecord } from './generations';
import type {
  PerspectiveConfig,
  ReasoningConfig,
  ReasoningMessage,
  ReasoningOverrideTriple,
} from './reasoning';
import {
  maybeApplyReflectionToResult,
  recordReasoningSummary,
} from './reasoning';
import * as reasoningCompletion from './reasoningCompletion';

const log = createDebug('soat:deliberation');

const AUTO_PERSONAS = [
  'Advocate',
  'Skeptic',
  'Pragmatist',
  'Realist',
  'Innovator',
];

const normalizePerspectives = (
  config: ReasoningConfig
): PerspectiveConfig[] => {
  const input = config.perspectives ?? 3;
  if (typeof input === 'number') {
    const count = Math.min(Math.max(2, input), 5);
    return AUTO_PERSONAS.slice(0, count).map((name) => {
      return { name };
    });
  }
  const arr = Array.isArray(input) ? input : [];
  return arr.slice(0, 5).map((p, i) => {
    return {
      ...p,
      name: p.name ?? AUTO_PERSONAS[i] ?? `Perspective ${i + 1}`,
    };
  });
};

const formatQuestion = (messages: ReasoningMessage[]): string => {
  return messages
    .filter((m) => {
      return (
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        (m.content as string).trim().length > 0
      );
    })
    .map((m) => {
      return `${m.role}: ${m.content as string}`;
    })
    .join('\n');
};

type TranscriptEntry = { name: string; text: string };

const buildPerspectivePrompt = (args: {
  name: string;
  customPrompt?: string;
  question: string;
  transcript: TranscriptEntry[];
}): string => {
  const parts: string[] = [];

  if (args.customPrompt) {
    parts.push(`You are ${args.name}.`, args.customPrompt);
  } else {
    parts.push(`You are ${args.name}. Respond from your perspective.`);
  }

  parts.push('', 'Question:', args.question);

  if (args.transcript.length > 0) {
    parts.push('', 'Previous perspectives:');
    for (const entry of args.transcript) {
      parts.push(`${entry.name}: ${entry.text}`);
    }
  }

  return parts.join('\n');
};

const DEFAULT_SYNTHESIS_INSTRUCTIONS =
  'Weigh the perspectives above and produce a single, well-reasoned answer. Commit to a recommendation and explain why.';

const buildSynthesisPrompt = (args: {
  customPrompt?: string;
  question: string;
  transcript: TranscriptEntry[];
}): string => {
  return [
    args.customPrompt ?? DEFAULT_SYNTHESIS_INSTRUCTIONS,
    '',
    'Question:',
    args.question,
    '',
    'Perspectives:',
    ...args.transcript.map((e) => {
      return `${e.name}: ${e.text}`;
    }),
  ].join('\n');
};

export type DebateResult = {
  text: string;
  applied: boolean;
  reason: 'synthesized' | 'skipped' | 'fallback' | 'synthesis_failed';
};

type DebateContext = {
  agentId: string;
  projectIds?: number[];
  projectId?: number;
  traceId?: string;
  initiatorGenerationId?: string;
  question: string;
  temperature?: number | null;
};

const createChildGenerationRecord = async (
  ctx: DebateContext
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
      'deliberation: failed to create child generation record error=%s',
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
};

const runPerspectiveTurns = async (
  ctx: DebateContext,
  perspectives: PerspectiveConfig[],
  maxRounds: number
): Promise<TranscriptEntry[]> => {
  const transcript: TranscriptEntry[] = [];
  for (let round = 0; round < maxRounds; round++) {
    for (const perspective of perspectives) {
      const name = perspective.name ?? 'Perspective';
      const childGenId = await createChildGenerationRecord(ctx);
      try {
        const text = await reasoningCompletion.runReasoningCompletion({
          agentId: ctx.agentId,
          projectIds: ctx.projectIds,
          aiProviderId: perspective.aiProviderId,
          model: perspective.model,
          prompt: buildPerspectivePrompt({
            name,
            customPrompt: perspective.prompt,
            question: ctx.question,
            transcript,
          }),
          temperature: ctx.temperature ?? undefined,
        });
        transcript.push({ name, text });
        log('runDebate: perspective=%s round=%d ok', name, round);
        if (childGenId) {
          void updateGenerationRecord({
            publicId: childGenId,
            status: 'completed',
            completedAt: new Date(),
            stopReason: 'stop',
            metadata: { reasoning: { perspective: name, output: text } },
          });
        }
      } catch (error) {
        log(
          'runDebate: perspective=%s round=%d failed error=%s',
          name,
          round,
          error instanceof Error ? error.message : String(error)
        );
        if (childGenId) {
          void updateGenerationRecord({
            publicId: childGenId,
            status: 'failed',
            completedAt: new Date(),
          });
        }
      }
    }
  }
  return transcript;
};

const runSynthesis = async (
  ctx: DebateContext,
  synthesis: ReasoningOverrideTriple,
  transcript: TranscriptEntry[]
): Promise<DebateResult> => {
  const childGenId = await createChildGenerationRecord(ctx);
  try {
    const synthesized = await reasoningCompletion.runReasoningCompletion({
      agentId: ctx.agentId,
      projectIds: ctx.projectIds,
      aiProviderId: synthesis.aiProviderId,
      model: synthesis.model,
      prompt: buildSynthesisPrompt({
        customPrompt: synthesis.prompt,
        question: ctx.question,
        transcript,
      }),
      temperature: ctx.temperature ?? undefined,
    });
    if (!synthesized.trim()) {
      if (childGenId) {
        void updateGenerationRecord({
          publicId: childGenId,
          status: 'failed',
          completedAt: new Date(),
        });
      }
      return { text: '', applied: false, reason: 'synthesis_failed' };
    }
    log('runDebate: synthesis complete agentId=%s', ctx.agentId);
    if (childGenId) {
      void updateGenerationRecord({
        publicId: childGenId,
        status: 'completed',
        completedAt: new Date(),
        stopReason: 'stop',
        metadata: {
          reasoning: { perspective: 'synthesis', output: synthesized },
        },
      });
    }
    return { text: synthesized, applied: true, reason: 'synthesized' };
  } catch (error) {
    log(
      'runDebate: synthesis failed agentId=%s error=%s',
      ctx.agentId,
      error instanceof Error ? error.message : String(error)
    );
    if (childGenId) {
      void updateGenerationRecord({
        publicId: childGenId,
        status: 'failed',
        completedAt: new Date(),
      });
    }
    return { text: '', applied: false, reason: 'synthesis_failed' };
  }
};

export const runDebate = async (args: {
  agentId: string;
  projectIds?: number[];
  projectId?: number;
  traceId?: string;
  initiatorGenerationId?: string;
  reasoning: ReasoningConfig;
  messages: ReasoningMessage[];
  temperature?: number | null;
}): Promise<DebateResult> => {
  if (args.reasoning.mode !== 'debate') {
    return { text: '', applied: false, reason: 'skipped' };
  }

  const perspectives = normalizePerspectives(args.reasoning);
  const maxRounds = Math.min(args.reasoning.maxRounds ?? 1, 3);
  const question = formatQuestion(args.messages);
  const ctx: DebateContext = {
    agentId: args.agentId,
    projectIds: args.projectIds,
    projectId: args.projectId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId,
    question,
    temperature: args.temperature,
  };

  log(
    'runDebate: agentId=%s perspectives=%d maxRounds=%d',
    args.agentId,
    perspectives.length,
    maxRounds
  );

  const transcript = await runPerspectiveTurns(ctx, perspectives, maxRounds);

  if (transcript.length === 0) {
    log(
      'runDebate: no perspectives succeeded, fallback agentId=%s',
      args.agentId
    );
    return { text: '', applied: false, reason: 'fallback' };
  }

  return runSynthesis(ctx, args.reasoning.synthesis ?? {}, transcript);
};

type DebatableResult = {
  text: string;
  response?: { messages?: Array<unknown>; modelId?: string };
};

/**
 * Pipeline hook: applies debate mode to a completed raw generation result
 * in place — the trace, completion event, and API response are all built
 * from the final text afterwards. Falls back to the draft when all perspectives
 * or synthesis fail.
 */
export const maybeApplyDebateToResult = async (args: {
  reasoningConfig?: ReasoningConfig | null;
  agentId: string;
  generationId: string;
  traceId?: string;
  projectId?: number;
  messages: ReasoningMessage[];
  result: DebatableResult;
  temperature?: number | null;
}): Promise<void> => {
  if (args.reasoningConfig?.mode !== 'debate') return;

  const debate = await runDebate({
    agentId: args.agentId,
    reasoning: args.reasoningConfig,
    messages: args.messages,
    temperature: args.temperature,
    traceId: args.traceId,
    projectId: args.projectId,
    initiatorGenerationId: args.generationId,
  });

  if (debate.applied) {
    args.result.text = debate.text;
    if (args.result.response) {
      args.result.response = { ...args.result.response, messages: undefined };
    }
  }

  void recordReasoningSummary({
    generationId: args.generationId,
    summary: {
      mode: 'debate',
      applied: debate.applied,
      reason: debate.reason,
    },
  });
};

type OrchestrationArgs = {
  reasoningConfig?: ReasoningConfig | null;
  agentId: string;
  generationId: string;
  traceId?: string;
  projectId?: number;
  messages: ReasoningMessage[];
  result: DebatableResult;
  temperature?: number | null;
};

/** Applies reflect or debate mode to the result in place. Modes are exclusive. */
export const applyOrchestration = async (
  args: OrchestrationArgs
): Promise<void> => {
  await maybeApplyReflectionToResult(args);
  await maybeApplyDebateToResult(args);
};
