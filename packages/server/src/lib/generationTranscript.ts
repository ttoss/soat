/**
 * Reading a generation back as a **transcript** — what it was asked, each model
 * step and tool call, each tool result, and how it ended.
 *
 * Assembled at read time from records that already exist. There is no
 * transcript table, column, or write on the generation path, and that inversion
 * against the dataset-item slice (#1012, which copies) is deliberate: a dataset
 * item must outlive its source, whereas a transcript must **die with it**.
 * Storing one would create a second, unpoliced copy of exactly the content
 * `traceContentPolicy` and `contentRetention` exist to erase, reviving the
 * "deleted but still reachable" gap #835/#836 closed.
 *
 * The three halves live in three places, which is why this module exists:
 * the input is a generation column (`inputMessages`), the steps are a File
 * hanging off the trace, and the outcome is the generation row.
 */
import createDebug from 'debug';

import {
  type GenerationWithTrace,
  loadGenerationWithTrace,
  readTraceSteps,
} from './generationTurn';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:generation-transcript');

export type TranscriptToolCall = {
  id: string | null;
  tool_name: string | null;
  /** Tool-owned payload, copied as a value — inner keys are never inspected. */
  args: unknown;
};

export type TranscriptToolResult = {
  tool_call_id: string | null;
  tool_name: string | null;
  /** Tool-owned payload, copied as a value. Null when the call errored. */
  result: unknown;
  /** The tool's failure, when the step recorded one. Null on success. */
  error: unknown;
};

export type TranscriptUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

export type TranscriptStep = {
  index: number;
  text: string;
  finish_reason: string | null;
  tool_calls: TranscriptToolCall[];
  tool_results: TranscriptToolResult[];
  usage: TranscriptUsage | null;
};

export type GenerationTranscript = {
  generation_id: string;
  trace_id: string | null;
  project_id: string;
  agent_id: string;
  agent_version: number | null;
  status: string;
  stop_reason: string | null;
  started_at: Date;
  completed_at: Date | null;
  step_count: number;
  input: unknown[] | null;
  steps: TranscriptStep[];
  output: { content: string | null; finish_reason: string | null } | null;
  error: Record<string, unknown> | null;
  content_redacted_at: Date | null;
  content_redacted_by_principal_type: string | null;
  content_redacted_by_principal_id: string | null;
};

/**
 * The content parts of one serialized step.
 *
 * Everything the projection reads comes from here, because `content` is the
 * only own property carrying it. `DefaultStepResult` in `ai@7` exposes `text`,
 * `toolCalls` and `toolResults` as **prototype getters** over this same array,
 * and `serializeSteps` goes through `JSON.stringify`, which copies own
 * enumerable properties only — so those three fields are absent from every
 * stored trace. Reading them would typecheck, pass against live SDK objects,
 * and return nothing for real data (the #1012 failure mode).
 */
const contentParts = (
  step: Record<string, unknown>
): Record<string, unknown>[] => {
  if (!Array.isArray(step.content)) return [];
  return step.content.filter(isPlainObject);
};

const partsOfType = (
  step: Record<string, unknown>,
  type: string
): Record<string, unknown>[] => {
  return contentParts(step).filter((part) => {
    return part.type === type;
  });
};

const asStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const stepText = (step: Record<string, unknown>): string => {
  return partsOfType(step, 'text')
    .map((part) => {
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('');
};

const projectToolCalls = (
  step: Record<string, unknown>
): TranscriptToolCall[] => {
  return partsOfType(step, 'tool-call').map((part) => {
    return {
      id: asStringOrNull(part.toolCallId),
      tool_name: asStringOrNull(part.toolName),
      args: part.input ?? null,
    };
  });
};

/**
 * Successful results and tool errors, in one ordered list.
 *
 * `ai@7` emits a failed call as a separate `tool-error` part rather than as a
 * result with an error field, but a reader debugging a turn wants both in one
 * place keyed by the call they answer — so both project into `tool_results`,
 * distinguished by which of `result` / `error` is set.
 */
const projectToolResults = (
  step: Record<string, unknown>
): TranscriptToolResult[] => {
  const results = partsOfType(step, 'tool-result').map((part) => {
    return {
      tool_call_id: asStringOrNull(part.toolCallId),
      tool_name: asStringOrNull(part.toolName),
      result: part.output ?? null,
      error: null,
    };
  });

  const errors = partsOfType(step, 'tool-error').map((part) => {
    return {
      tool_call_id: asStringOrNull(part.toolCallId),
      tool_name: asStringOrNull(part.toolName),
      result: null,
      error: part.error ?? null,
    };
  });

  return [...results, ...errors];
};

const asTokenCount = (value: unknown): number | null => {
  return typeof value === 'number' ? value : null;
};

const projectUsage = (
  step: Record<string, unknown>
): TranscriptUsage | null => {
  if (!isPlainObject(step.usage)) return null;

  return {
    input_tokens: asTokenCount(step.usage.inputTokens),
    output_tokens: asTokenCount(step.usage.outputTokens),
    total_tokens: asTokenCount(step.usage.totalTokens),
  };
};

const EMPTY_STEP = {
  text: '',
  finish_reason: null,
  tool_calls: [],
  tool_results: [],
  usage: null,
};

/**
 * Projects stored steps into the documented transcript shape.
 *
 * Read-time serialization, the same as every other mapper: the stored shape is
 * provider- and SDK-shaped, so pinning it as a public contract would freeze an
 * internal detail of the `ai` package. Degrades rather than throws — the steps
 * object is read back from storage, so a corrupt or unfamiliar step must cost
 * that step's detail, not the whole response.
 */
export const projectTranscriptSteps = (steps: unknown): TranscriptStep[] => {
  if (!Array.isArray(steps)) return [];

  return steps.map((step, index) => {
    if (!isPlainObject(step)) return { index, ...EMPTY_STEP };

    return {
      index,
      text: stepText(step),
      finish_reason: asStringOrNull(step.finishReason),
      tool_calls: projectToolCalls(step),
      tool_results: projectToolResults(step),
      usage: projectUsage(step),
    };
  });
};

/**
 * The turn's final answer, from its projected steps.
 *
 * Scans backwards for the last step carrying non-empty text rather than reading
 * the last step blindly: a run that stopped on a tool call has no text of its
 * own, and the answer worth reporting is the one before it. `finish_reason`
 * comes from the actual last step, because that is what ended the run.
 */
const deriveOutput = (
  steps: TranscriptStep[]
): { content: string | null; finish_reason: string | null } | null => {
  if (steps.length === 0) return null;

  const answered = [...steps].reverse().find((step) => {
    return step.text.trim() !== '';
  });

  return {
    content: answered?.text ?? null,
    finish_reason: steps[steps.length - 1].finish_reason,
  };
};

/**
 * The two content halves of a transcript, or their absence.
 *
 * The generation's redaction marker governs **both**, and the steps object is
 * not even read when it is set. A generation purge clears the generation's own
 * columns and the copies on any eval result that scored it, but it does not
 * delete the trace's steps file — that belongs to
 * `DELETE /traces/{id}/content`. The turn's answer and its tool payloads live
 * in both places, so projecting the file after the generation was purged would
 * hand back the very content the purge erased, in a response whose own
 * `content_redacted_at` says it is gone. That is the "deleted but still
 * reachable" gap #835/#836 closed, and it is why this slice references rather
 * than copies in the first place.
 */
const resolveTranscriptContent = async (
  generation: GenerationWithTrace
): Promise<{ input: unknown[] | null; steps: TranscriptStep[] }> => {
  if (generation.contentRedactedAt !== null) {
    return { input: null, steps: [] };
  }

  const inputMessages = generation.inputMessages;

  return {
    input:
      Array.isArray(inputMessages) && inputMessages.length > 0
        ? inputMessages
        : null,
    steps: projectTranscriptSteps(await readTraceSteps(generation.trace?.file)),
  };
};

/**
 * Reads one generation's turn as a transcript.
 *
 * Unlike `getGenerationTurn`, this **never refuses** for missing content. Two
 * states that would make a dataset item worthless are ordinary here, and both
 * answer `200` with the skeleton:
 *
 * - **Content unavailable** — zero-retention never wrote it, or a purge cleared
 *   it. The redaction marker says which, and `content_redacted_by_principal_id`
 *   distinguishes never-stored (`zero_retention`) from erased-later (a user or
 *   key id). This matches what the traces module already guarantees: a purged
 *   trace reads back as a skeleton rather than a 404, so the erasure is
 *   *provable* instead of indistinguishable from a resource that never existed.
 * - **Still running** — the steps object is not written until the run finishes,
 *   so `steps` is empty and `status` disambiguates. It stays a plain array with
 *   no null-vs-empty ambiguity.
 *
 * `step_count` survives both, because it is a counter rather than content.
 */
export const getGenerationTranscript = async (args: {
  generationId: string;
  projectIds?: number[];
}): Promise<GenerationTranscript> => {
  log('getGenerationTranscript: generationId=%s', args.generationId);

  const generation = await loadGenerationWithTrace({
    generationId: args.generationId,
    projectIds: args.projectIds,
  });

  /* istanbul ignore next -- both are non-null FKs, so neither association can
     be missing; the guard exists to narrow the types below. */
  if (!generation.project || !generation.agent) {
    throw new Error(
      `Generation '${args.generationId}' is missing its project or agent.`
    );
  }

  const { input, steps } = await resolveTranscriptContent(generation);

  return {
    generation_id: generation.publicId,
    trace_id: generation.trace?.publicId ?? null,
    project_id: generation.project.publicId,
    agent_id: generation.agent.publicId,
    agent_version: generation.agentVersion,
    status: generation.status,
    stop_reason: generation.stopReason,
    started_at: generation.startedAt,
    completed_at: generation.completedAt,
    // The trace's counter, not `steps.length`: it is part of the skeleton a
    // purge preserves, so it still reports the size of a turn whose content
    // is gone.
    step_count: generation.trace?.stepCount ?? 0,
    input,
    steps,
    output: deriveOutput(steps),
    error: generation.error,
    content_redacted_at: generation.contentRedactedAt,
    content_redacted_by_principal_type:
      generation.contentRedactedByPrincipalType,
    content_redacted_by_principal_id: generation.contentRedactedByPrincipalId,
  };
};
