/**
 * Scorers: the pure half of the evaluations module (docs/prd-evaluations.md).
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

import { evaluateLogic } from './jsonLogicMapping';
import { validateStructuredOutput } from './outputSchema';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:evaluations');

/**
 * Scorer types Phase 1 executes. `llm_judge` is specified by the PRD but lands
 * with Phase 2 (it needs the ai-providers completion path), so it is rejected
 * by name rather than silently accepted and never run.
 */
export const SCORER_TYPES = [
  'exact_match',
  'contains',
  'json_logic',
  'output_schema',
] as const;

export type ScorerType = (typeof SCORER_TYPES)[number];

/** Declared in the PRD, not executable until Phase 2. */
export const DEFERRED_SCORER_TYPES = ['llm_judge'] as const;

/** The config keys each scorer type accepts, beyond `type`. */
const SCORER_FIELDS: Record<ScorerType, readonly string[]> = {
  exact_match: [],
  contains: ['value', 'case_sensitive'],
  json_logic: ['expression'],
  output_schema: ['schema'],
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

const isScorerType = (value: string): value is ScorerType => {
  return (SCORER_TYPES as readonly string[]).includes(value);
};

type ScorerCheck = (args: {
  scorer: Record<string, unknown>;
  path: string;
  agentHasOutputSchema: boolean;
}) => string | null;

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
};

const validateOneScorer = (args: {
  scorer: Record<string, unknown>;
  path: string;
  agentHasOutputSchema: boolean;
}): string | null => {
  const { scorer, path } = args;
  const type = scorer.type;

  if ((DEFERRED_SCORER_TYPES as readonly unknown[]).includes(type)) {
    return `${path}.type '${String(type)}' is not available yet; it ships with Evaluations Phase 2.`;
  }
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
 * Runs every scorer against one item's generation output.
 *
 * Called only for a `completed` generation — a non-`completed` one is an
 * item-level *error* and is never scored (see `evaluationRuns.ts`).
 */
export const scoreOutput = (args: {
  scorers: unknown[];
  input: unknown;
  output: ScoredOutput;
  expectedOutput: string | null;
  itemMetadata: unknown;
  agentOutputSchema: unknown;
}): ScorerOutcome[] => {
  const context = buildJsonLogicContext({
    input: args.input,
    output: args.output,
    expectedOutput: args.expectedOutput,
    itemMetadata: args.itemMetadata,
  });

  return args.scorers.map((raw) => {
    const scorer = asRecord(raw) ?? {};
    switch (scorer.type as ScorerType) {
      case 'exact_match':
        return scoreExactMatch({
          output: args.output,
          expectedOutput: args.expectedOutput,
        });
      case 'contains':
        return scoreContains({ scorer, output: args.output });
      case 'json_logic':
        return scoreJsonLogic({ scorer, context });
      case 'output_schema':
      default:
        return scoreOutputSchema({
          scorer,
          output: args.output,
          agentOutputSchema: args.agentOutputSchema,
        });
    }
  });
};

// ── Aggregation ────────────────────────────────────────────────────────────

/** Per-scorer rollup plus the run-level pass rate, in the wire shape. */
export type AggregateScores = {
  scorers: Record<string, { mean: number; pass_rate: number }>;
  pass_rate: number | null;
  scored_item_count: number;
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
 * (docs/prd-evaluations.md — Pass semantics).
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
