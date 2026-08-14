/**
 * Scorers: the pure half of the evaluations module (the evaluations module doc).
 *
 * Everything here is a function of its arguments — no DB, no I/O — which is
 * what lets `tests/unit/tests/lib/evaluationScorers.test.ts` drive the whole
 * input space directly rather than constructing a project, agent, dataset and
 * run per branch (`.claude/rules/tests.md` — keep-list rule 1).
 *
 * Two shapes are load-bearing:
 *
 * - **Every scorer returns `{ score: 0–1, passed: boolean }`.** Binary scorers
 *   emit 0/1. One shape keeps aggregation, thresholds and (Phase 2) baseline
 *   deltas scorer-agnostic, so a new scorer type needs no aggregation change.
 * - **A scorer reads the generation's two output channels explicitly.** Text
 *   scorers read `output.content`; `output_schema` validates `output.object`
 *   and never re-parses the text. `json_logic` sees both.
 */
import createDebug from 'debug';

import { DomainError } from '../errors';
import type { BaselineComparison } from './evaluationDeltas';
import { evaluateLogic } from './jsonLogicMapping';
import { validateStructuredOutput } from './outputSchema';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:evaluations');

/** Every scorer type the module executes. */
export const SCORER_TYPES = [
  'exact_match',
  'contains',
  'json_logic',
  'output_schema',
  'llm_judge',
] as const;

export type ScorerType = (typeof SCORER_TYPES)[number];

/**
 * The one scorer whose score comes from a provider call rather than from the
 * output alone. Everything else here is pure, which is why judging is injected
 * (see {@link scoreOutput}) instead of imported.
 */
export const JUDGE_SCORER_TYPE = 'llm_judge';

/** The config keys each scorer type accepts, beyond `type`. */
const SCORER_FIELDS: Record<ScorerType, readonly string[]> = {
  exact_match: [],
  contains: ['value', 'case_sensitive'],
  json_logic: ['expression'],
  output_schema: ['schema'],
  llm_judge: ['ai_provider_id', 'model', 'prompt', 'pass_threshold'],
};

export type ScorerOutcome = {
  scorer: string;
  score: number;
  passed: boolean;
  reasoning?: string;
};

/** The generation output channels a scorer may read. */
export type ScoredOutput = {
  /** `output.content` — the final text. */
  content: string;
  /** `output.object` — structured output; absent when the agent has no schema. */
  object?: unknown;
};

// ── Validation ─────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return isPlainObject(value) ? value : null;
};

const SCORER_TYPE_SET: ReadonlySet<unknown> = new Set(SCORER_TYPES);

/**
 * Takes `unknown` rather than `string` because it guards two callers: the
 * validator, which reads a type off an untyped template, and {@link scoreOne},
 * which reads one off a stored Eval. The latter used to reach its dispatch
 * through an `as ScorerType` cast (#1001).
 */
const isScorerType = (value: unknown): value is ScorerType => {
  return SCORER_TYPE_SET.has(value);
};

type ScorerCheck = (args: {
  scorer: Record<string, unknown>;
  path: string;
  agentHasOutputSchema: boolean;
}) => string | null;

/**
 * A finite number in `[0, 1]`.
 *
 * `llm_judge.pass_threshold` is required with no default: a judge emits a
 * continuous score, so nothing about the score itself says where "good enough"
 * is — and a defaulted cutoff would silently decide the gate every run-level
 * `passed` is computed from (the evaluations module doc — Pass semantics).
 */
const isUnitInterval = (value: unknown): boolean => {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
};

/**
 * The per-type config rules, keyed by type so a new entry in
 * {@link SCORER_TYPES} is a type error here until its checks are declared — a
 * scorer can never silently skip validation.
 */
const SCORER_CHECKS: Record<ScorerType, ScorerCheck> = {
  exact_match: () => {
    return null;
  },
  contains: ({ scorer, path }) => {
    if (typeof scorer.value !== 'string' || scorer.value === '') {
      return `${path}.value is required and must be a non-empty string.`;
    }
    if (
      scorer.case_sensitive !== undefined &&
      typeof scorer.case_sensitive !== 'boolean'
    ) {
      return `${path}.case_sensitive must be a boolean.`;
    }
    return null;
  },
  json_logic: ({ scorer, path }) => {
    return scorer.expression === undefined
      ? `${path}.expression is required.`
      : null;
  },
  output_schema: ({ scorer, path, agentHasOutputSchema }) => {
    if (scorer.schema !== undefined && !isPlainObject(scorer.schema)) {
      return `${path}.schema must be a JSON Schema object.`;
    }
    // The platform only produces `output.object` when the **agent** carries an
    // `output_schema` — `buildStructuredOutput` is what constrains the model.
    // A scorer schema against an unconstrained agent would find `object`
    // permanently absent and score 0 on every item of every run: a fabricated
    // regression, which is the exact signal this module exists to prevent.
    if (!agentHasOutputSchema) {
      return `${path} requires the agent under test to have an output_schema; without one the agent produces no structured output to validate.`;
    }
    return null;
  },
  llm_judge: ({ scorer, path }) => {
    if (typeof scorer.prompt !== 'string' || scorer.prompt.trim() === '') {
      return `${path}.prompt is required and must be a non-empty string.`;
    }
    if (!isUnitInterval(scorer.pass_threshold)) {
      return `${path}.pass_threshold is required and must be a number between 0 and 1.`;
    }
    if (
      scorer.ai_provider_id !== undefined &&
      typeof scorer.ai_provider_id !== 'string'
    ) {
      return `${path}.ai_provider_id must be an ai provider id.`;
    }
    if (scorer.model !== undefined && typeof scorer.model !== 'string') {
      return `${path}.model must be a string.`;
    }
    return null;
  },
};

const validateOneScorer = (args: {
  scorer: Record<string, unknown>;
  path: string;
  agentHasOutputSchema: boolean;
}): string | null => {
  const { scorer, path } = args;
  const type = scorer.type;

  if (typeof type !== 'string' || !isScorerType(type)) {
    return `${path}.type must be one of ${SCORER_TYPES.join(' / ')}.`;
  }

  const allowed = new Set<string>(['type', ...SCORER_FIELDS[type]]);
  const unknown = Object.keys(scorer).filter((key) => {
    return !allowed.has(key);
  });
  if (unknown.length > 0) {
    return `${path} has unknown field(s) for type '${type}': ${unknown.join(', ')}.`;
  }

  return SCORER_CHECKS[type]({ ...args, scorer });
};

/**
 * Validates an Eval's `scorers` array. Returns the first problem as a message
 * naming the offending field, or `null` when valid.
 *
 * Pure and shared: the REST create/update path and the run-start re-check both
 * call it, so the rules are defined once (`.claude/rules/modules.md` — Shared
 * Business Rules). The re-check at run start is the authoritative one — the
 * agent's `output_schema` is mutable, so an Eval that validated at create time
 * can stop being runnable later.
 */
export const validateScorers = (args: {
  scorers: unknown;
  agentHasOutputSchema: boolean;
}): string | null => {
  if (!Array.isArray(args.scorers) || args.scorers.length === 0) {
    return 'scorers must be a non-empty array.';
  }

  const seen = new Set<string>();

  for (const [index, raw] of args.scorers.entries()) {
    const path = `scorers.${index}`;
    const scorer = asRecord(raw);
    if (!scorer) return `${path} must be an object.`;

    const error = validateOneScorer({
      scorer,
      path,
      agentHasOutputSchema: args.agentHasOutputSchema,
    });
    if (error) return error;

    // Aggregate scores are keyed by scorer type, so two scorers of the same
    // type would collapse into one bucket and silently lose a signal.
    const type = scorer.type as string;
    if (seen.has(type)) {
      return `${path}.type '${type}' is declared more than once; each scorer type may appear at most once per eval.`;
    }
    seen.add(type);
  }

  return null;
};

/**
 * An Eval's `scorers` column as an array.
 *
 * The column is NOT NULL and {@link validateScorers} rejects anything but a
 * non-empty array at create, at update, and again at run start, so the fallback
 * is unreachable through every entry point — it is here only so a hand-edited
 * row cannot crash a run mid-flight.
 */
export const scorerList = (scorers: unknown): unknown[] => {
  /* istanbul ignore next -- unreachable; see above. */
  return Array.isArray(scorers) ? scorers : [];
};

// ── Scoring ────────────────────────────────────────────────────────────────

const binary = (scorer: string, hit: boolean): ScorerOutcome => {
  return { scorer, score: hit ? 1 : 0, passed: hit };
};

const scoreExactMatch = (args: {
  output: ScoredOutput;
  expectedOutput: string | null;
}): ScorerOutcome => {
  // A reference answer is what `exact_match` compares against; with none there
  // is nothing to be right about, so the item cannot pass.
  if (args.expectedOutput === null) return binary('exact_match', false);
  return binary(
    'exact_match',
    args.output.content.trim() === args.expectedOutput.trim()
  );
};

const scoreContains = (args: {
  scorer: Record<string, unknown>;
  output: ScoredOutput;
}): ScorerOutcome => {
  const value = String(args.scorer.value);
  const caseSensitive = args.scorer.case_sensitive === true;
  const haystack = caseSensitive
    ? args.output.content
    : args.output.content.toLowerCase();
  const needle = caseSensitive ? value : value.toLowerCase();
  return binary('contains', haystack.includes(needle));
};

/**
 * The variables a `json_logic` expression may read.
 *
 * `object` is deliberately absent (rather than null) for an agent with no
 * `output_schema`: `{ var: 'object.x' }` over a missing path resolves to `null`
 * in the shared engine, so an expression written for structured output simply
 * evaluates falsy instead of erroring.
 */
export const buildJsonLogicContext = (args: {
  input: unknown;
  output: ScoredOutput;
  expectedOutput: string | null;
  itemMetadata: unknown;
}): Record<string, unknown> => {
  return {
    input: args.input,
    output: args.output.content,
    ...(args.output.object === undefined ? {} : { object: args.output.object }),
    expected: args.expectedOutput,
    item: { metadata: args.itemMetadata ?? null },
  };
};

const scoreJsonLogic = (args: {
  scorer: Record<string, unknown>;
  context: Record<string, unknown>;
}): ScorerOutcome => {
  // The shared `LogicEngine` — the same evaluator orchestration mappings use —
  // so assertion semantics are identical everywhere and no second expression
  // language enters the platform.
  const result = evaluateLogic(args.scorer.expression, args.context);
  return binary('json_logic', Boolean(result));
};

const scoreOutputSchema = (args: {
  scorer: Record<string, unknown>;
  output: ScoredOutput;
  agentOutputSchema: unknown;
}): ScorerOutcome => {
  // A `completed` generation that produced no structured object failed to
  // answer in the required shape — a genuine behavioral 0, not an error.
  if (args.output.object === undefined) return binary('output_schema', false);

  const schema =
    args.scorer.schema !== undefined
      ? args.scorer.schema
      : args.agentOutputSchema;
  const validation = validateStructuredOutput(schema)(args.output.object);
  return binary('output_schema', validation.success);
};

/**
 * How a judge verdict is obtained. Injected rather than imported so this module
 * holds no I/O: the run path passes `runJudgeCompletion` from
 * `evaluationJudge.ts`, and a test can drive the threshold boundary directly.
 *
 * A rejection propagates out of {@link scoreOutput} — the caller records the
 * item as **errored**. A judge that cannot answer says nothing about the agent,
 * so it must not land as a score of 0.
 */
export type JudgeRunner = (args: {
  scorer: Record<string, unknown>;
  input: unknown;
  output: string;
  expected: string | null;
}) => Promise<{ score: number; reasoning?: string }>;

const scoreJudge = async (args: {
  scorer: Record<string, unknown>;
  input: unknown;
  output: ScoredOutput;
  expectedOutput: string | null;
  runJudge: JudgeRunner;
}): Promise<ScorerOutcome> => {
  const verdict = await args.runJudge({
    scorer: args.scorer,
    input: args.input,
    output: args.output.content,
    expected: args.expectedOutput,
  });

  // Unlike the binary scorers, the score is continuous and `passed` comes from
  // the scorer's own required cutoff — `>=`, so a verdict exactly at the
  // threshold passes.
  const threshold = Number(args.scorer.pass_threshold);
  return {
    scorer: JUDGE_SCORER_TYPE,
    score: verdict.score,
    passed: verdict.score >= threshold,
    ...(verdict.reasoning === undefined
      ? {}
      : { reasoning: verdict.reasoning }),
  };
};

const scoreOne = async (args: {
  scorer: Record<string, unknown>;
  context: Record<string, unknown>;
  input: unknown;
  output: ScoredOutput;
  expectedOutput: string | null;
  agentOutputSchema: unknown;
  runJudge?: JudgeRunner;
}): Promise<ScorerOutcome> => {
  const { scorer } = args;
  const scorerType = scorer.type;

  if (!isScorerType(scorerType)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Unhandled scorer type: ${String(scorerType)}.`
    );
  }

  switch (scorerType) {
    case 'exact_match':
      return scoreExactMatch({
        output: args.output,
        expectedOutput: args.expectedOutput,
      });
    case 'contains':
      return scoreContains({ scorer, output: args.output });
    case 'json_logic':
      return scoreJsonLogic({ scorer, context: args.context });
    case 'llm_judge': {
      /* istanbul ignore next -- validateScorers rejects a judge scorer at Eval
         create, and the run path always supplies a runner, so an Eval with a
         judge and no runner is unreachable through any entry point. */
      if (!args.runJudge) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'An llm_judge scorer needs a judge runner; none was supplied.'
        );
      }
      return scoreJudge({
        scorer,
        input: args.input,
        output: args.output,
        expectedOutput: args.expectedOutput,
        runJudge: args.runJudge,
      });
    }
    case 'output_schema':
      return scoreOutputSchema({
        scorer,
        output: args.output,
        agentOutputSchema: args.agentOutputSchema,
      });
    default: {
      /* A new entry in SCORER_TYPES is a type error here until it is dispatched
         — the compile-time half of the guarantee, matching the one SCORER_FIELDS
         and SCORER_CHECKS already give validation. */
      const unhandled: never = scorerType;
      throw new DomainError(
        'VALIDATION_FAILED',
        `Unhandled scorer type: ${String(unhandled)}.`
      );
    }
  }
};

/**
 * Runs every scorer against one item's generation output, in the order the Eval
 * declares them.
 *
 * Called only for a `completed` generation — a non-`completed` one is an
 * item-level *error* and is never scored (see `evaluationRuns.ts`).
 *
 * Async only because of `llm_judge`; every other scorer stays a pure function of
 * its arguments. An Eval with no judge never awaits anything real.
 */
export const scoreOutput = async (args: {
  scorers: unknown[];
  input: unknown;
  output: ScoredOutput;
  expectedOutput: string | null;
  itemMetadata: unknown;
  agentOutputSchema: unknown;
  runJudge?: JudgeRunner;
}): Promise<ScorerOutcome[]> => {
  const context = buildJsonLogicContext({
    input: args.input,
    output: args.output,
    expectedOutput: args.expectedOutput,
    itemMetadata: args.itemMetadata,
  });

  const outcomes: ScorerOutcome[] = [];

  for (const raw of args.scorers) {
    const scorer = asRecord(raw) ?? {};
    outcomes.push(
      await scoreOne({
        scorer,
        context,
        input: args.input,
        output: args.output,
        expectedOutput: args.expectedOutput,
        agentOutputSchema: args.agentOutputSchema,
        runJudge: args.runJudge,
      })
    );
  }

  return outcomes;
};

// ── Aggregation ────────────────────────────────────────────────────────────

/** Per-scorer rollup plus the run-level pass rate, in the wire shape. */
export type AggregateScores = {
  scorers: Record<string, { mean: number; pass_rate: number }>;
  pass_rate: number | null;
  scored_item_count: number;
  /**
   * Present only when the run named a `baseline_run_id`. Computed over the item
   * intersection with divergence counts, so a delta is never presented as a
   * clean comparison when the two runs' item sets differ (`evaluationDeltas.ts`).
   */
  baseline?: BaselineComparison;
};

const ratio = (numerator: number, denominator: number): number => {
  return denominator === 0 ? 0 : numerator / denominator;
};

/**
 * Rolls per-item outcomes up to the run level.
 *
 * Only **non-errored** items are included: an item whose generation could not
 * be evaluated (a `requires_action` pause, a provider failure) says nothing
 * about the agent's answers, so counting it would depress the score with
 * infrastructure noise.
 *
 * `pass_rate` is `null` when nothing was scorable — an honest "no signal",
 * distinct from a genuine 0.
 */
export const aggregateScores = (args: {
  results: Array<{
    scores: ScorerOutcome[];
    passed: boolean;
    errored: boolean;
  }>;
}): AggregateScores => {
  const scored = args.results.filter((result) => {
    return !result.errored;
  });

  const byScorer = new Map<
    string,
    { total: number; passes: number; n: number }
  >();
  for (const result of scored) {
    for (const outcome of result.scores) {
      const bucket = byScorer.get(outcome.scorer) ?? {
        total: 0,
        passes: 0,
        n: 0,
      };
      bucket.total += outcome.score;
      bucket.passes += outcome.passed ? 1 : 0;
      bucket.n += 1;
      byScorer.set(outcome.scorer, bucket);
    }
  }

  const scorers: AggregateScores['scorers'] = {};
  for (const [scorer, bucket] of byScorer) {
    scorers[scorer] = {
      mean: ratio(bucket.total, bucket.n),
      pass_rate: ratio(bucket.passes, bucket.n),
    };
  }

  const passedItems = scored.filter((result) => {
    return result.passed;
  }).length;

  log(
    'aggregateScores: scored=%d passed=%d scorers=%d',
    scored.length,
    passedItems,
    byScorer.size
  );

  return {
    scorers,
    pass_rate: scored.length === 0 ? null : ratio(passedItems, scored.length),
    scored_item_count: scored.length,
  };
};

/**
 * The run-level verdict.
 *
 * Gates on the **pass rate**, never on a pooled mean: pooling 0/1 binaries with
 * 0–1 judge fractions produces a unit-less number whose meaning shifts whenever
 * a scorer is added — a gate value nobody can reason about
 * (the evaluations module doc — Pass semantics).
 *
 * `null` when the Eval declares no threshold (it reports without gating), and
 * `false` when a threshold exists but nothing was scorable — a run that
 * measured nothing must not read as a pass.
 */
export const resolveRunPassed = (args: {
  passThreshold: number | null;
  aggregate: AggregateScores;
}): boolean | null => {
  if (args.passThreshold === null) return null;
  if (args.aggregate.pass_rate === null) return false;
  return args.aggregate.pass_rate >= args.passThreshold;
};
