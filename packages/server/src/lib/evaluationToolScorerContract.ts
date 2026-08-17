/**
 * The pure half of the `tool` scorer contract (the evaluations module doc —
 * Custom scorers): its config rules and its verdict semantics.
 *
 * Lives apart from both neighbours on purpose. `evaluationScorers.ts` hosts
 * the scorer algebra and dispatch, and only *delegates* here; keeping the tool
 * contract out keeps that file at the size where the whole algebra is readable
 * at once. `evaluationToolScorer.ts` holds the I/O half (the DB ref checks and
 * the actual call) and must not be imported by the pure kernel, so the pieces
 * both halves share live in this dependency-free middle.
 */
import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

/**
 * The input keys the engine injects into a tool scorer's call — exactly the
 * variables a `json_logic` scorer reads (`buildJsonLogicContext`), so the two
 * algorithm surfaces see one contract. `preset_parameters` may not declare
 * them: the engine's values must win, unconditionally, or a scorer config
 * could pin `output` and grade a fiction.
 */
export const TOOL_SCORER_RESERVED_KEYS = [
  'input',
  'output',
  'object',
  'expected',
  'item',
] as const;

/**
 * What a tool scorer's tool answered, already shape-checked by the runner
 * (`parseToolScorerOutput` in `evaluationToolScorer.ts`).
 */
export type ToolScorerVerdict = {
  /** 0–1. */
  score: number;
  /** The tool's own pass/fail, when it chose to state one. */
  passed?: boolean;
  reasoning?: string;
};

/**
 * How a tool scorer's verdict is obtained. Injected into the scorer kernel
 * rather than imported by it, for the same reason as its `JudgeRunner`: the
 * kernel holds no I/O. The run path passes `runToolScorerCall` from
 * `evaluationToolScorer.ts`.
 *
 * `context` is the `buildJsonLogicContext` value — a custom algorithm reads
 * exactly the variables a `json_logic` expression reads, so there is one
 * item-context contract, not two.
 *
 * A rejection propagates out of scoring — the caller records the item as
 * **errored**. A scorer tool that cannot answer says nothing about the agent,
 * so it must not land as a score of 0.
 */
export type ToolScorerRunner = (args: {
  scorer: Record<string, unknown>;
  context: Record<string, unknown>;
}) => Promise<ToolScorerVerdict>;

/**
 * A finite number in `[0, 1]` — the shape shared by every scorer threshold
 * (`llm_judge.pass_threshold`, the tool scorer's optional fallback) and every
 * score.
 */
export const isUnitInterval = (value: unknown): boolean => {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
};

/** The identity half of a tool scorer config: `name` and `tool_id`. */
const checkToolScorerIdentity = (args: {
  scorer: Record<string, unknown>;
  path: string;
  isBuiltInTypeName: (name: string) => boolean;
}): string | null => {
  const { scorer, path } = args;
  if (typeof scorer.name !== 'string' || scorer.name.trim() === '') {
    return `${path}.name is required and must be a non-empty string.`;
  }
  // Outcomes and aggregate scores key on the name, so a name that is also a
  // built-in type would collapse two scorers into one bucket.
  if (args.isBuiltInTypeName(scorer.name)) {
    return `${path}.name must not be a built-in scorer type ('${scorer.name}'); pick a name of your own.`;
  }
  if (typeof scorer.tool_id !== 'string' || scorer.tool_id === '') {
    return `${path}.tool_id is required and must be a tool id.`;
  }
  return null;
};

/** The call half: `action`, `preset_parameters`, `pass_threshold`. */
const checkToolScorerCall = (args: {
  scorer: Record<string, unknown>;
  path: string;
}): string | null => {
  const { scorer, path } = args;
  if (scorer.action !== undefined && typeof scorer.action !== 'string') {
    return `${path}.action must be a string.`;
  }
  if (scorer.preset_parameters !== undefined) {
    if (!isPlainObject(scorer.preset_parameters)) {
      return `${path}.preset_parameters must be an object.`;
    }
    const reserved = TOOL_SCORER_RESERVED_KEYS.find((key) => {
      return key in (scorer.preset_parameters as Record<string, unknown>);
    });
    if (reserved) {
      return `${path}.preset_parameters cannot contain the reserved key '${reserved}' — the engine injects it.`;
    }
  }
  if (
    scorer.pass_threshold !== undefined &&
    !isUnitInterval(scorer.pass_threshold)
  ) {
    return `${path}.pass_threshold must be a number between 0 and 1.`;
  }
  return null;
};

/**
 * The per-type config rules of a `tool` scorer, shaped like every other entry
 * of the kernel's `SCORER_CHECKS`. `isBuiltInTypeName` is passed in rather
 * than imported so this module depends on nothing in the kernel.
 */
export const checkToolScorerConfig = (args: {
  scorer: Record<string, unknown>;
  path: string;
  isBuiltInTypeName: (name: string) => boolean;
}): string | null => {
  return (
    checkToolScorerIdentity(args) ??
    checkToolScorerCall({ scorer: args.scorer, path: args.path })
  );
};

/**
 * `passed` for a tool scorer outcome: the tool's own verdict when it stated
 * one, else the config's `pass_threshold` (`>=`, matching `llm_judge`). With
 * neither there is no way to decide, and guessing would corrupt the run-level
 * gate — so the item errors, the same rule as a judge that cannot answer.
 */
export const resolveToolScorerPassed = (args: {
  name: string;
  scorer: Record<string, unknown>;
  verdict: ToolScorerVerdict;
}): boolean => {
  if (typeof args.verdict.passed === 'boolean') return args.verdict.passed;
  if (isUnitInterval(args.scorer.pass_threshold)) {
    return args.verdict.score >= Number(args.scorer.pass_threshold);
  }
  throw new DomainError(
    'VALIDATION_FAILED',
    `Tool scorer '${args.name}' answered without a passed verdict and declares no pass_threshold; return passed from the tool or set pass_threshold on the scorer.`
  );
};
