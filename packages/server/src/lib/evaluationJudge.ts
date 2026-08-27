/**
 * The `llm_judge` scorer's provider call (the evaluations module doc).
 *
 * A judge is just a completion: it resolves its model through the ordinary
 * ai-providers path, so it meters and traces like any other call. It runs
 * tool-less, and the only thing sent is the rendered judge prompt, so a judged
 * output cannot trigger side effects.
 *
 * Split from `evaluationScorers.ts` so that module stays pure, which is what
 * lets the deterministic scorer space be driven directly in a `lib/` test. The
 * two pure halves of judging live here, exported so they can be tested without
 * a provider.
 */
import { generateText } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import { meterCompletion, routedMaxRetries } from './modelRoutes';
import { isPlainObject } from './plainObject';
import { resolveProjectScopedModel } from './projectScopedModel';

const log = createDebug('soat:evaluations');

/**
 * Usage attribution for a judge's own completion. Distinct from `eval` (the
 * item generations) so a cost rollup can tell the price of *running* a suite
 * from the price of *grading* it — judging doubles the calls, which is the
 * module's headline cost risk.
 */
export const JUDGE_USAGE_SOURCE = 'eval_judge';

/** What a judge returns for one item. */
export type JudgeVerdict = {
  /** 0–1. */
  score: number;
  reasoning?: string;
};

// ── Prompt rendering ───────────────────────────────────────────────────────

/**
 * Serializes one slot value for interpolation. A string goes in verbatim;
 * anything else (the item's `input` is an array of messages) is JSON so the
 * judge sees the structure rather than `[object Object]`.
 */
const renderSlot = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
};

/**
 * Fills the `{{input}}` / `{{output}}` / `{{expected}}` slots of a judge prompt.
 *
 * Slots are replaced literally and in one pass over the template, so a slot
 * value that itself contains `{{output}}` is never re-expanded — a judged output
 * is untrusted text, and re-scanning it would let it rewrite the prompt that
 * grades it. An unknown `{{…}}` is left as-is: the author wrote it, and silently
 * blanking it would hide the typo.
 */
export const renderJudgePrompt = (args: {
  prompt: string;
  input: unknown;
  output: string;
  expected: string | null;
}): string => {
  const slots: Record<string, string> = {
    input: renderSlot(args.input),
    output: args.output,
    expected: renderSlot(args.expected),
  };

  return args.prompt.replace(
    /\{\{(input|output|expected)\}\}/g,
    (match, name: string) => {
      return slots[name] ?? match;
    }
  );
};

// ── Verdict parsing ────────────────────────────────────────────────────────

/**
 * Parses `{score, reasoning}` out of a judge's reply.
 *
 * Lenient about the envelope (models fence JSON, or prefix it with prose): the
 * first `{ … }` span is parsed, as `memoryExtraction.parseFactCandidates` reads
 * an LLM array. Strict about the contract: `score` must be a finite number in
 * 0–1, since an out-of-range value would corrupt every aggregate pooling it.
 *
 * Throws `VALIDATION_FAILED` on a malformed reply, which the caller turns into
 * an **item-level error** — a judge failing to answer says nothing about the
 * agent, so it must not be recorded as a score of 0.
 */
/** The first `{ … }` span in the text, parsed, or null when there is none. */
const firstJsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** The judge's `score`, or a `VALIDATION_FAILED` naming why it is unusable. */
const requireJudgeScore = (score: unknown): number => {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The judge's score is not a number: ${JSON.stringify(score)}`
    );
  }
  if (score < 0 || score > 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The judge's score ${score} is outside the 0–1 range.`
    );
  }
  return score;
};

export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  const parsed = firstJsonObject(text);
  if (!parsed) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `The judge did not answer with a JSON object: ${text.slice(0, 200)}`
    );
  }

  const { reasoning } = parsed;
  return {
    score: requireJudgeScore(parsed.score),
    ...(typeof reasoning === 'string' && reasoning !== '' ? { reasoning } : {}),
  };
};

// ── The call ───────────────────────────────────────────────────────────────

/**
 * Runs one judge completion and returns its parsed verdict.
 *
 * Model resolution is project-scoped (`resolveProjectScopedModel`): the
 * scorer's `ai_provider_id` must belong to the eval's project (so a scorer
 * config can never borrow another project's provider secret), and a project
 * default model route applies when the scorer pins no provider. That is the same
 * resolution every non-agent completion in the platform already uses.
 *
 * `temperature: 0` because a judge is a measuring instrument — the run-to-run
 * variance that makes a red run ambiguous is exactly what this module exists to
 * remove.
 */
export const runJudgeCompletion = async (args: {
  projectId: number;
  scorer: Record<string, unknown>;
  input: unknown;
  output: string;
  expected: string | null;
  abortSignal?: AbortSignal;
}): Promise<JudgeVerdict> => {
  const aiProviderId =
    typeof args.scorer.ai_provider_id === 'string'
      ? args.scorer.ai_provider_id
      : null;
  const pinnedModel =
    typeof args.scorer.model === 'string' ? args.scorer.model : null;

  const { model, modelName, attribution } = await resolveProjectScopedModel({
    projectId: args.projectId,
    aiProviderId,
    model: pinnedModel,
  });

  const prompt = renderJudgePrompt({
    prompt: String(args.scorer.prompt),
    input: args.input,
    output: args.output,
    expected: args.expected,
  });

  log(
    'runJudgeCompletion: projectId=%d model=%s promptChars=%d',
    args.projectId,
    modelName,
    prompt.length
  );

  const { text, usage } = await generateText({
    model,
    prompt,
    temperature: 0,
    abortSignal: args.abortSignal,
    maxRetries: routedMaxRetries(model) ?? 1,
  });

  // A real provider call, so it meters like any other. Attributed `eval_judge`
  // to keep grading spend separable from the run's own item generations.
  meterCompletion({
    model,
    fallback: attribution,
    source: JUDGE_USAGE_SOURCE,
    projectId: args.projectId,
    pinnedModel: modelName,
    usage,
  });

  return parseJudgeVerdict(text);
};
