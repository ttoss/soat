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
import { DomainError } from '../errors';
import {
  checkToolScorerConfig,
  isUnitInterval,
  resolveToolScorerPassed,
  type ToolScorerRunner,
} from './evaluationToolScorerContract';
import { evaluateLogic } from './jsonLogicMapping';
import { validateStructuredOutput } from './outputSchema';
import { isPlainObject } from './plainObject';

// The tool scorer's pure contract — its config rules, verdict semantics, and
// runner types — lives in `evaluationToolScorerContract.ts`; re-exported here
// so consumers of the scorer algebra see one surface.
export {
  TOOL_SCORER_RESERVED_KEYS,
  type ToolScorerRunner,
  type ToolScorerVerdict,
} from './evaluationToolScorerContract';

/** Every scorer type the module executes. */
export const SCORER_TYPES = [
  'exact_match',
  'contains',
  'json_logic',
  'output_schema',
  'llm_judge',
  'tool',
] as const;

export type ScorerType = (typeof SCORER_TYPES)[number];

/**
 * The one scorer whose score comes from a provider call rather than from the
 * output alone. Everything else here is pure, which is why judging is injected
 * (see {@link scoreOutput}) instead of imported.
 */
export const JUDGE_SCORER_TYPE = 'llm_judge';

/**
 * The scorer that runs a caller-authored algorithm — a project [tool] invoked
 * with the item's context. Like judging, the invocation is injected (see
 * {@link ToolScorerRunner}) so this module stays pure; the call itself lives in
 * `evaluationToolScorer.ts`.
 */
export const TOOL_SCORER_TYPE = 'tool';

/** The config keys each scorer type accepts, beyond `type`. */
const SCORER_FIELDS: Record<ScorerType, readonly string[]> = {
  exact_match: [],
  contains: ['value', 'case_sensitive'],
  json_logic: ['expression'],
  output_schema: ['schema'],
  llm_judge: ['ai_provider_id', 'model', 'prompt', 'pass_threshold'],
  tool: ['name', 'tool_id', 'action', 'preset_parameters', 'pass_threshold'],
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

// `llm_judge.pass_threshold` is required with no default: a judge emits a
// continuous score, so nothing about the score itself says where "good enough"
// is — and a defaulted cutoff would silently decide the gate every run-level
// `passed` is computed from (the evaluations module doc — Pass semantics).
// `isUnitInterval` (shared with the tool scorer's optional threshold) comes
// from `evaluationToolScorerContract.ts`.

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
  tool: ({ scorer, path }) => {
    return checkToolScorerConfig({
      scorer,
      path,
      isBuiltInTypeName: (name) => {
        return SCORER_TYPE_SET.has(name);
      },
    });
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

    // Aggregate scores are keyed by the outcome's scorer key — the type for
    // built-ins, the scorer's own `name` for tool scorers — so two scorers
    // sharing a key would collapse into one bucket and silently lose a signal.
    // Tool scorers may therefore appear several times, under distinct names.
    const type = scorer.type as string;
    const key = type === TOOL_SCORER_TYPE ? (scorer.name as string) : type;
    if (seen.has(key)) {
      return type === TOOL_SCORER_TYPE
        ? `${path}.name '${key}' is declared more than once; each tool scorer name may appear at most once per eval.`
        : `${path}.type '${key}' is declared more than once; each scorer type may appear at most once per eval.`;
    }
    seen.add(key);
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

/**
 * Grades one item with the caller's own algorithm. The runner (injected — see
 * {@link ToolScorerRunner}) does the I/O and shape-checks the answer; the
 * verdict semantics live in `evaluationToolScorerContract.ts`.
 */
const scoreToolScorer = async (args: {
  scorer: Record<string, unknown>;
  context: Record<string, unknown>;
  runToolScorer: ToolScorerRunner;
}): Promise<ScorerOutcome> => {
  const verdict = await args.runToolScorer({
    scorer: args.scorer,
    context: args.context,
  });

  const name = String(args.scorer.name);
  return {
    scorer: name,
    score: verdict.score,
    passed: resolveToolScorerPassed({ name, scorer: args.scorer, verdict }),
    ...(verdict.reasoning === undefined
      ? {}
      : { reasoning: verdict.reasoning }),
  };
};

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
  runToolScorer?: ToolScorerRunner;
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
    case 'tool': {
      /* istanbul ignore next -- the run path always supplies a runner, so a
         tool scorer with none is unreachable through any entry point. */
      if (!args.runToolScorer) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'A tool scorer needs a tool runner; none was supplied.'
        );
      }
      return scoreToolScorer({
        scorer,
        context: args.context,
        runToolScorer: args.runToolScorer,
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
  runToolScorer?: ToolScorerRunner;
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
        runToolScorer: args.runToolScorer,
      })
    );
  }

  return outcomes;
};

// Run-level aggregation (`aggregateScores`, `resolveRunPassed`,
// `AggregateScores`) lives in `evaluationScorerAggregation.ts`: scoring
// produces one item's outcomes, and the roll-up over persisted outcomes is a
// separate consumer's concern (the run finalizer's).
