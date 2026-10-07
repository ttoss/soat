/**
 * Scorer validation: the registry of scorer types and the config rules each
 * one is held to. Pure, like the scoring kernel in `evaluationScorers.ts`,
 * which re-exports this surface so consumers see one module.
 */
import {
  checkDeciderScorerConfig,
  DECIDER_SCORER_TYPE,
} from './evaluationDeciderScorerContract';
import { checkEmbeddingScorerConfig } from './evaluationEmbeddingScorer';
import {
  checkToolScorerConfig,
  isUnitInterval,
} from './evaluationToolScorerContract';
import { isPlainObject } from './plainObject';

/** Every scorer type the module executes. */
export const SCORER_TYPES = [
  'exact_match',
  'contains',
  'json_logic',
  'embedding_similarity',
  'output_schema',
  'llm_judge',
  'tool',
  'decider',
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
  embedding_similarity: ['pass_threshold'],
  output_schema: ['schema'],
  llm_judge: ['ai_provider_id', 'model', 'prompt', 'pass_threshold'],
  tool: ['name', 'tool_id', 'action', 'preset_parameters', 'pass_threshold'],
  decider: ['name', 'decider_id', 'input', 'score', 'pass_threshold'],
};

/** The scorer types keyed by their `name` rather than their type. */
const NAMED_SCORER_TYPES: ReadonlySet<unknown> = new Set([
  TOOL_SCORER_TYPE,
  DECIDER_SCORER_TYPE,
]);

// ── Validation ─────────────────────────────────────────────────────────────

const SCORER_TYPE_SET: ReadonlySet<unknown> = new Set(SCORER_TYPES);

/**
 * Takes `unknown` rather than `string` because it guards two callers: the
 * validator, which reads a type off an untyped template, and {@link scoreOne},
 * which reads one off a stored Eval and would otherwise reach its dispatch
 * through an `as ScorerType` cast.
 */
export const isScorerType = (value: unknown): value is ScorerType => {
  return SCORER_TYPE_SET.has(value);
};

type ScorerCheck = (args: {
  scorer: Record<string, unknown>;
  path: string;
  agentHasOutputSchema: boolean;
}) => string | null;

// Required with no default: a judge emits a continuous score, so nothing about
// it says where "good enough" is, and a defaulted cutoff would silently decide
// the gate every run-level `passed` is computed from.

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
  embedding_similarity: checkEmbeddingScorerConfig,
  output_schema: ({ scorer, path, agentHasOutputSchema }) => {
    if (scorer.schema !== undefined && !isPlainObject(scorer.schema)) {
      return `${path}.schema must be a JSON Schema object.`;
    }
    // `output.object` exists only when the *agent* carries an `output_schema`.
    // A scorer schema against an unconstrained agent would find it permanently
    // absent and score 0 on every item — a fabricated regression.
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
  decider: ({ scorer, path }) => {
    return checkDeciderScorerConfig({
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
    const scorer = isPlainObject(raw) ? raw : null;
    if (!scorer) return `${path} must be an object.`;

    const error = validateOneScorer({
      scorer,
      path,
      agentHasOutputSchema: args.agentHasOutputSchema,
    });
    if (error) return error;

    // Keyed by the outcome's scorer key, so two scorers sharing one would
    // collapse into a single bucket and silently lose a signal.
    const type = scorer.type as string;
    const named = NAMED_SCORER_TYPES.has(type);
    const key = named ? (scorer.name as string) : type;
    if (seen.has(key)) {
      return named
        ? `${path}.name '${key}' is declared more than once; each ${type} scorer name may appear at most once per eval.`
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
