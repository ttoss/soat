/**
 * Scorers: the pure half of the evaluations module.
 *
 * No DB, no I/O, so `lib/evaluationScorers.test.ts` drives the whole input
 * space directly (`.claude/rules/tests.md` — keep-list rule 1). Two shapes are
 * load-bearing: every scorer returns `{ score: 0–1, passed: boolean }`, which
 * keeps aggregation and thresholds scorer-agnostic; and a scorer reads the
 * generation's output channels explicitly — text scorers `output.content`,
 * `output_schema` only `output.object`, `json_logic` both.
 */
import { DomainError } from '../errors';
import {
  type DeciderScorerRunner,
  scoreDeciderScorer,
} from './evaluationDeciderScorerContract';
import {
  type EmbeddingScorerRunner,
  scoreEmbeddingSimilarity,
} from './evaluationEmbeddingScorer';
import { isScorerType, JUDGE_SCORER_TYPE } from './evaluationScorerValidation';
import {
  resolveToolScorerPassed,
  type ToolScorerRunner,
} from './evaluationToolScorerContract';
import { evaluateLogic } from './jsonLogicMapping';
import { validateStructuredOutput } from './outputSchema';
import { isPlainObject } from './plainObject';

export {
  isScorerType,
  JUDGE_SCORER_TYPE,
  SCORER_TYPES,
  scorerList,
  type ScorerType,
  TOOL_SCORER_TYPE,
  validateScorers,
} from './evaluationScorerValidation';

// The tool scorer's pure contract — its config rules, verdict semantics, and
// runner types — lives in `evaluationToolScorerContract.ts`; re-exported here
// so consumers of the scorer algebra see one surface.
export {
  TOOL_SCORER_RESERVED_KEYS,
  type ToolScorerRunner,
  type ToolScorerVerdict,
} from './evaluationToolScorerContract';

// The embedding scorer's pure contract lives in
// `evaluationEmbeddingScorer.ts`; re-exported here for the same reason.
export {
  cosineSimilarity,
  EMBEDDING_SCORER_TYPE,
  type EmbeddingScorerRunner,
} from './evaluationEmbeddingScorer';

export type ScorerOutcome = {
  scorer: string;
  score: number;
  passed: boolean;
  reasoning?: string;
  /** The decision that graded the item, for a `decider` scorer. */
  decision_id?: string;
};

/** The generation output channels a scorer may read. */
export type ScoredOutput = {
  /** `output.content` — the final text. */
  content: string;
  /** `output.object` — structured output; absent when the agent has no schema. */
  object?: unknown;
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

/**
 * The injected runner a scorer type needs, or the `VALIDATION_FAILED` the
 * dispatch throws without one. Unreachable through every entry point — the run
 * path supplies every runner — so the throw exists only to keep a hand-called
 * `scoreOutput` honest.
 */
const requireRunner = <Runner>(
  runner: Runner | undefined,
  scorerType: string
): Runner => {
  /* istanbul ignore next -- unreachable; see above. */
  if (!runner) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `A ${scorerType} scorer needs its runner; none was supplied.`
    );
  }
  return runner;
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
  runEmbeddings?: EmbeddingScorerRunner;
  runDecider?: DeciderScorerRunner;
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
    case 'llm_judge':
      return scoreJudge({
        scorer,
        input: args.input,
        output: args.output,
        expectedOutput: args.expectedOutput,
        runJudge: requireRunner(args.runJudge, scorerType),
      });
    case 'tool':
      return scoreToolScorer({
        scorer,
        context: args.context,
        runToolScorer: requireRunner(args.runToolScorer, scorerType),
      });
    case 'decider':
      return scoreDeciderScorer({
        scorer,
        context: args.context,
        runDecider: requireRunner(args.runDecider, scorerType),
      });
    case 'embedding_similarity':
      return scoreEmbeddingSimilarity({
        scorer,
        output: args.output,
        expectedOutput: args.expectedOutput,
        runEmbeddings: requireRunner(args.runEmbeddings, scorerType),
      });
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
  runEmbeddings?: EmbeddingScorerRunner;
  runDecider?: DeciderScorerRunner;
}): Promise<ScorerOutcome[]> => {
  const context = buildJsonLogicContext({
    input: args.input,
    output: args.output,
    expectedOutput: args.expectedOutput,
    itemMetadata: args.itemMetadata,
  });

  const outcomes: ScorerOutcome[] = [];

  for (const raw of args.scorers) {
    const scorer = isPlainObject(raw) ? raw : {};
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
        runEmbeddings: args.runEmbeddings,
        runDecider: args.runDecider,
      })
    );
  }

  return outcomes;
};

// Run-level aggregation lives in `evaluationScorerAggregation.ts`: scoring
// produces one item's outcomes, and the roll-up is the run finalizer's concern.
