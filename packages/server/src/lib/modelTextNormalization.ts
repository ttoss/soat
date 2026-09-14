import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { extractReasoningMiddleware, wrapLanguageModel } from 'ai';
import createDebug from 'debug';

const log = createDebug('soat:model-text-normalization');

// Derived from the SDK's own union rather than importing `@ai-sdk/provider`
// directly, for the reason `modelRouteExecutor.ts` gives: the middleware has to
// speak exactly what `buildModel`'s products speak.

/** Every model object `LanguageModel` admits, as opposed to a model id string. */
export type ProviderModel = Extract<
  LanguageModel,
  { specificationVersion: string }
>;
type ProviderModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type GenerateResult = Awaited<ReturnType<ProviderModelV4['doGenerate']>>;
type StreamResult = Awaited<ReturnType<ProviderModelV4['doStream']>>;
type ContentPart = GenerateResult['content'][number];
type StreamPart =
  StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;

/**
 * What one rule did to a text run. `applied` is empty when the rule did not
 * fire, and carries one name per outcome otherwise — a rule that both rewrites
 * and recognises reports both.
 */
type RuleOutcome = { text: string; applied: string[] };

/**
 * One normalisation rule over a model's text channel.
 *
 * Adding a leak is an entry in `NORMALIZATION_RULES`: the rewrite, the outcome
 * names it counts, and — where a match can straddle a stream delta — how much
 * of a partial run it must hold back before it can decide.
 */
export type NormalizationRule = {
  apply: (text: string) => RuleOutcome;
  /**
   * Characters at the end of a partial run that may still grow into a match.
   * Held back from the emitted delta until more arrives or the run ends.
   */
  pendingTailLength?: (text: string) => number;
};

/**
 * Reasoning scaffolding a model writes into the text channel instead of into a
 * reasoning part. A short, stable list: adding a tag is a string here, never a
 * code path.
 */
export const REASONING_TAGS = [
  'thinking',
  'think',
  'reasoning',
  'scratchpad',
] as const;

/**
 * Tokenizer special tokens, anchored on the out-of-band opener every vendor
 * builds them with — an angle bracket plus an ASCII or fullwidth pipe — and
 * closed by `>`, whitespace or the end of the run. One rule covers DeepSeek,
 * Llama, Qwen, Mistral and GPT-OSS, and vendors that do not exist yet.
 *
 * `[INST]`, `<<SYS>>` and `<s>` are out on purpose: in-band ASCII that collides
 * with prose a tenant may legitimately send. A boundary, not a gap.
 */
const SPECIAL_TOKEN = /<[|｜][^\s>]*>?/gu;

/** One special token, whole, with the name between its pipes captured. */
const DELIMITED_TOKEN = /^<[|｜]([^|｜\s>]+)[|｜]>$/u;

/**
 * Harmony's channel framing. Recognised and passed through unchanged, because
 * stripping is worse than leaving it: the markers would go and the analysis
 * body would stay, reading as the answer. Extraction waits until such a model
 * is served here.
 */
const CHANNEL_MARKERS = new Set([
  'channel',
  'constrain',
  'end',
  'message',
  'return',
  'start',
]);

/**
 * How much of a partial run the special-token rule will hold back. Real special
 * tokens are far shorter; the bound is what keeps an unclosed `<|` in a long
 * prose run from buffering the rest of the stream.
 */
const SPECIAL_TOKEN_MAX_HOLD = 128;

const isChannelMarker = (token: string): boolean => {
  const name = DELIMITED_TOKEN.exec(token)?.[1];
  return name !== undefined && CHANNEL_MARKERS.has(name);
};

const specialTokenRule: NormalizationRule = {
  apply: (text) => {
    const applied = new Set<string>();
    const next = text.replace(SPECIAL_TOKEN, (token) => {
      if (isChannelMarker(token)) {
        applied.add('channel_marker_recognized');
        return token;
      }
      applied.add('special_token_stripped');
      return '';
    });
    return { text: next, applied: [...applied] };
  },
  pendingTailLength: (text) => {
    const opener = text.lastIndexOf('<');
    if (opener < 0) return 0;
    const tail = text.slice(opener);
    if (tail.length > SPECIAL_TOKEN_MAX_HOLD) return 0;
    // A bare `<` at the very end is the one character that may still become an
    // opener once the next delta arrives.
    if (tail.length === 1) return 1;
    if (tail[1] !== '|' && tail[1] !== '｜') return 0;
    // Whitespace or `>` already closed the run, so `apply` can decide on it.
    return /[\s>]/u.test(tail) ? 0 : tail.length;
  },
};

/**
 * Every rule applied to a model's text channel, in order. A new leak is one
 * entry here plus its cases in `modelTextNormalization.test.ts`.
 *
 * Reasoning tags are not here: extracting them has to *emit* a reasoning part,
 * which `extractReasoningMiddleware` already does, so they are driven from
 * `REASONING_TAGS` instead.
 */
export const NORMALIZATION_RULES: NormalizationRule[] = [specialTokenRule];

/** Characters no rule can decide on yet, given what the run holds so far. */
const pendingTailLength = (text: string): number => {
  return NORMALIZATION_RULES.reduce((held, rule) => {
    return Math.max(held, rule.pendingTailLength?.(text) ?? 0);
  }, 0);
};

const applyRules = (text: string): RuleOutcome => {
  return NORMALIZATION_RULES.reduce<RuleOutcome>(
    (outcome, rule) => {
      const next = rule.apply(outcome.text);
      return {
        text: next.text,
        applied: [...outcome.applied, ...next.applied],
      };
    },
    { text, applied: [] }
  );
};

export type NormalizationCount = {
  rule: string;
  provider: string;
  model: string;
  count: number;
};

/**
 * In-process counts of every rule that fired, so the next vendor's markup
 * surfaces as telemetry here instead of as a downstream bug report. Deliberately
 * not a database write: the figure is diagnostic, and a per-token write would
 * sit on the generation hot path.
 */
const counters = new Map<string, NormalizationCount>();

export const normalizationCounterSnapshot = (): NormalizationCount[] => {
  return [...counters.values()];
};

/** Test-only: clears the counters so runs don't leak across tests. */
export const resetNormalizationCounters = (): void => {
  counters.clear();
};

type ModelIdentity = { provider: string; model: string };

const countNormalizations = (args: {
  applied: string[];
  identity: ModelIdentity;
}): void => {
  for (const rule of args.applied) {
    const key = `${rule}|${args.identity.provider}|${args.identity.model}`;
    const current = counters.get(key);
    if (current) {
      current.count += 1;
    } else {
      counters.set(key, { rule, ...args.identity, count: 1 });
    }
    log(
      'normalization_applied: rule=%s provider=%s model=%s',
      rule,
      args.identity.provider,
      args.identity.model
    );
  }
};

/**
 * Rewrites the text parts of a generated result.
 *
 * A part that normalises to whitespace is dropped rather than shipped blank —
 * including one the reasoning extractors emptied, which is why a part no rule
 * of ours touched can be dropped too. The result's only part is the exception:
 * dropping it would answer a caller with no content at all where the provider
 * genuinely sent whitespace.
 */
const normalizeContent = (args: {
  content: ContentPart[];
  identity: ModelIdentity;
}): ContentPart[] => {
  return args.content.flatMap((part): ContentPart[] => {
    if (part.type !== 'text') return [part];
    const outcome = applyRules(part.text);
    countNormalizations({ applied: outcome.applied, identity: args.identity });
    const blank = outcome.text.trim() === '';
    if (blank && (outcome.applied.length > 0 || args.content.length > 1)) {
      return [];
    }
    if (outcome.applied.length === 0) return [part];
    return [{ ...part, text: outcome.text }];
  });
};

/**
 * Per-run streaming state.
 *
 * `pending` is the raw tail no rule can decide on yet. `blank` is normalised
 * text held back because the run has shipped nothing and whitespace is all it
 * has so far — it may yet turn out to be all a rule leaves behind. `start` is
 * held with it, so a run a rule empties leaves no blank text part behind.
 */
type TextRun = {
  pending: string;
  blank: string;
  start: StreamPart | null;
  emitted: boolean;
  applied: boolean;
};

type StreamController = TransformStreamDefaultController<StreamPart>;

/**
 * The per-run half of the stream path, kept apart from the transform so each
 * stays one readable piece: this owns the runs in flight, the transform only
 * routes chunks to it.
 */
const createRunNormalizer = (identity: ModelIdentity) => {
  const runs = new Map<string, TextRun>();

  const runFor = (id: string): TextRun => {
    const existing = runs.get(id);
    if (existing) return existing;
    const created: TextRun = {
      pending: '',
      blank: '',
      start: null,
      emitted: false,
      applied: false,
    };
    runs.set(id, created);
    return created;
  };

  const emit = (emission: {
    run: TextRun;
    id: string;
    text: string;
    controller: StreamController;
  }): void => {
    if (emission.text === '') return;
    if (emission.run.start) {
      emission.controller.enqueue(emission.run.start);
      emission.run.start = null;
    }
    emission.run.emitted = true;
    emission.controller.enqueue({
      type: 'text-delta',
      id: emission.id,
      delta: emission.text,
    });
  };

  /** Normalises everything decidable in `raw`, counting what fired. */
  const consume = (run: TextRun, raw: string): string => {
    const outcome = applyRules(raw);
    countNormalizations({ applied: outcome.applied, identity });
    run.applied ||= outcome.applied.length > 0;
    return run.blank + outcome.text;
  };

  return {
    start: (chunk: StreamPart & { id: string }): void => {
      runFor(chunk.id).start = chunk;
    },

    delta: (args: {
      id: string;
      delta: string;
      controller: StreamController;
    }): void => {
      const run = runFor(args.id);
      const pending = run.pending + args.delta;
      const held = pendingTailLength(pending);
      run.pending = pending.slice(pending.length - held);
      const text = consume(run, pending.slice(0, pending.length - held));
      if (!run.emitted && text.trim() === '') {
        run.blank = text;
        return;
      }
      run.blank = '';
      emit({ run, id: args.id, text, controller: args.controller });
    },

    end: (args: {
      chunk: StreamPart & { id: string };
      controller: StreamController;
    }): void => {
      const run = runFor(args.chunk.id);
      const text = consume(run, run.pending);
      runs.delete(args.chunk.id);
      // Nothing shipped and nothing but whitespace left of what a rule
      // rewrote: the run is dropped whole, start and end with it. A run that
      // was already blank before any rule is passed through untouched.
      if (!run.emitted && run.applied && text.trim() === '') return;
      emit({ run, id: args.chunk.id, text, controller: args.controller });
      if (run.start) args.controller.enqueue(run.start);
      args.controller.enqueue(args.chunk);
    },
  };
};

const normalizeStream = (args: {
  stream: ReadableStream<StreamPart>;
  identity: ModelIdentity;
}): ReadableStream<StreamPart> => {
  const normalizer = createRunNormalizer(args.identity);
  return args.stream.pipeThrough(
    new TransformStream<StreamPart, StreamPart>({
      transform: (chunk, controller) => {
        if (chunk.type === 'text-start') return normalizer.start(chunk);
        if (chunk.type === 'text-delta') {
          return normalizer.delta({
            id: chunk.id,
            delta: chunk.delta,
            controller,
          });
        }
        if (chunk.type === 'text-end') {
          return normalizer.end({ chunk, controller });
        }
        controller.enqueue(chunk);
      },
    })
  );
};

const normalizationMiddleware = (
  identity: ModelIdentity
): LanguageModelMiddleware => {
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      return {
        ...result,
        content: normalizeContent({ content: result.content, identity }),
      };
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      return {
        ...result,
        stream: normalizeStream({ stream: result.stream, identity }),
      };
    },
  };
};

/**
 * Wraps a provider's model so provider control markup never reaches the text
 * channel a caller reads.
 *
 * The normalisation middleware is outermost on purpose: it runs *after* the
 * reasoning extractors, so a text part they emptied is dropped rather than
 * shipped blank.
 */
export const withModelTextNormalization = (args: {
  model: ProviderModel;
  provider: string;
  modelId: string;
}): LanguageModel => {
  log(
    'withModelTextNormalization: provider=%s model=%s',
    args.provider,
    args.modelId
  );
  return wrapLanguageModel({
    model: args.model,
    middleware: [
      normalizationMiddleware({
        provider: args.provider,
        model: args.modelId,
      }),
      ...REASONING_TAGS.map((tagName) => {
        return extractReasoningMiddleware({ tagName });
      }),
    ],
  });
};
