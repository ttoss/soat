import {
  emitReasoningFallbackEvent,
  isFallbackReason,
  type ReasoningConfig,
  type ReasoningMessage,
  type ReasoningStep,
  recordReasoningSummary,
} from './reasoning';
import { formatQuestion, runReasoningPipeline } from './reasoningPipeline';

type PipelineResult = {
  text: string;
  response?: { messages?: Array<unknown>; modelId?: string };
};

/**
 * Reads the raw `mode` string, including legacy values (`reflect`/`debate`)
 * that may still be stored on agents created before the pipeline migration but
 * are no longer part of the `mode` union.
 */
const readMode = (config?: ReasoningConfig | null): string | undefined => {
  const mode = config?.mode;
  return typeof mode === 'string' ? mode : undefined;
};

/** Returns the steps to run, or null when the pipeline should be skipped. */
const pipelineStepsToRun = (args: {
  config?: ReasoningConfig | null;
  mode?: string;
  draft: string;
}): ReasoningStep[] | null => {
  const steps = args.config?.steps;
  if (
    args.mode !== 'pipeline' ||
    !Array.isArray(steps) ||
    steps.length === 0 ||
    args.draft.trim().length === 0
  ) {
    return null;
  }
  return steps;
};

/**
 * Reasoning hook: applies `mode: pipeline` reasoning to a completed raw
 * generation result in place — the trace, completion event, and API response
 * are all built from the final text afterwards. A no-op for `none`/effort-only
 * configs; a stored legacy mode is inert but emits a fallback event so the
 * degradation is observable.
 */
export const applyReasoningPipeline = async (args: {
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
  const mode = readMode(config);

  // A legacy mode (the removed reflect/debate) is inert post-migration: the
  // plain draft is returned. Surface it rather than degrading silently.
  if (mode && mode !== 'none' && mode !== 'pipeline') {
    emitReasoningFallbackEvent({
      projectId: args.projectId,
      projectPublicId: args.projectPublicId,
      generationId: args.generationId,
      mode,
      reason: 'fallback',
      data: { legacyMode: true },
    });
    return;
  }

  const steps = pipelineStepsToRun({ config, mode, draft: args.result.text });
  if (!steps) return;

  const outcome = await runReasoningPipeline({
    agentId: args.agentId,
    steps,
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
      // Derived from the reason (not `!applied`) so an intentional
      // `halt_if_equals` short-circuit is not mislabelled as a degradation.
      fallback: isFallbackReason(outcome.reason),
    },
  });
};
