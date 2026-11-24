/**
 * The agent's `stop_conditions`, resolved into the AI SDK `stopWhen` array the
 * generation loop actually runs under.
 *
 * A `stopWhen` of `isStepCount(maxSteps)` alone would leave the "done tool"
 * idiom (`modules/agents.md` — Stop Conditions) terminating only by accident of
 * the model choosing to stop.
 *
 * Also how a turn ends on its budget: the step that must answer
 * ({@link resolveAnswerStep}) and the object it must yield
 * ({@link readTurnObject}). Every path resolves these here — the fresh turn,
 * streamed or not, its no-tools retry, and the resume after
 * `submit-tool-outputs` — so no two paths derive them apart.
 */
import {
  hasToolCall,
  isStepCount,
  NoOutputGeneratedError,
  type StopCondition,
  ToolChoiceViolationError,
  type ToolSet,
} from 'ai';

import { DomainError } from '../errors';
import { forcesATool } from './agentStepRules';
import { resolveMaxSteps, type TurnBudget } from './generationStopReason';
import { isPlainObject } from './plainObject';
import { toProviderDomainError } from './providerError';

/**
 * The condition vocabulary. Not every entry is a per-turn predicate: a condition
 * declares *when the work stops*, and the work has two axes — the steps inside
 * one turn, and the generations inside one continuation chain. Keeping both in
 * one field is what lets an author express "stop after the done tool, and never
 * grow this chain past 20 turns" in one place; keeping them apart in
 * {@link resolveStopWhen} is what stops a chain-scoped number from silently
 * capping every turn's step count.
 */
export const STOP_CONDITION_TYPES = [
  'has_tool_call',
  'max_chain_generations',
] as const;

const KNOWN_TYPES: ReadonlySet<string> = new Set(STOP_CONDITION_TYPES);

const readType = (entry: Record<string, unknown>): string | null => {
  return typeof entry.type === 'string' ? entry.type : null;
};

const readToolName = (entry: Record<string, unknown>): string | null => {
  return typeof entry.tool_name === 'string' && entry.tool_name.length > 0
    ? entry.tool_name
    : null;
};

/**
 * A chain ceiling is only meaningful as a positive whole number of generations.
 * `0`, a fraction, or a numeric *string* all read as "no ceiling" downstream,
 * which would silently fall back to the platform budget — the opposite of what
 * an author writing a smaller number is asking for.
 */
const readMaxGenerations = (entry: Record<string, unknown>): number | null => {
  const value = entry.max_generations;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
};

const invalid = (
  message: string,
  meta: Record<string, unknown>
): DomainError => {
  return new DomainError('VALIDATION_FAILED', message, meta);
};

/** One entry, checked against its own type's requirements. */
const assertValidCondition = (entry: unknown): void => {
  if (!isPlainObject(entry)) {
    throw invalid('Each stop condition must be an object.', {
      condition: entry,
    });
  }
  const type = readType(entry);
  if (!type || !KNOWN_TYPES.has(type)) {
    throw invalid(
      `Stop condition type must be one of: ${STOP_CONDITION_TYPES.join(', ')}.`,
      { condition: entry }
    );
  }
  if (type === 'has_tool_call' && !readToolName(entry)) {
    throw invalid(
      'A has_tool_call stop condition requires a non-empty tool_name.',
      { condition: entry }
    );
  }
  if (type === 'max_chain_generations' && !readMaxGenerations(entry)) {
    throw invalid(
      'A max_chain_generations stop condition requires max_generations to be a positive integer.',
      { condition: entry }
    );
  }
};

/**
 * Rejects a `stop_conditions` value the loop could not act on, so a typo is a
 * `400` on write rather than a condition that never fires. An unknown `type` is
 * refused here even though {@link resolveStopWhen} tolerates one at runtime: a
 * stored row may hold one, but a write accepting one would store a condition
 * that never fires.
 */
export const assertValidStopConditions = (value: unknown): void => {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw invalid('stop_conditions must be an array.', {
      stop_conditions: value,
    });
  }

  for (const entry of value) {
    assertValidCondition(entry);
  }
};

/**
 * Whether a `stop_conditions` value declares a condition that can end a *turn*.
 * Only `has_tool_call` can: `max_chain_generations` caps how many generations a
 * chain spawns and never shortens the turn it is evaluated on.
 */
const declaresTurnExit = (stopConditions: unknown): boolean => {
  if (!Array.isArray(stopConditions)) return false;
  return stopConditions.some((entry) => {
    if (!isPlainObject(entry)) return false;
    return readType(entry) === 'has_tool_call' && Boolean(readToolName(entry));
  });
};

/**
 * Refuses an agent that forces tool use on every step without declaring how a
 * turn ends.
 *
 * A forcing `tool_choice` forbids a final assistant message, so the only exit
 * left to any turn is exhausting `max_steps`. On the turn the author wrote that
 * may be deliberate; on a continuation carrying an approval decision back to
 * the agent it means the decision is never reported — the turn burns its steps
 * proposing more calls, and where those calls are gated too, each approval buys
 * another approval instead of an answer.
 *
 * Requiring the terminal condition makes that configuration unwritable, which
 * is what lets a continuation run under the author's forcing unaltered. It
 * cannot *guarantee* the model calls the named tool — nothing can — but it
 * guarantees an exit exists to be reached.
 *
 * Evaluated against the config a write leaves behind, never the fields it
 * names: removing the exit and adding the forcing are the same violation
 * arriving from opposite directions.
 */
export const assertForcedToolChoiceCanStop = (args: {
  toolChoice: unknown;
  stopConditions: unknown;
}): void => {
  if (!forcesATool(args.toolChoice)) return;
  if (declaresTurnExit(args.stopConditions)) return;
  throw new DomainError(
    'FORCED_TOOL_CHOICE_CANNOT_STOP',
    'An agent whose tool_choice forces a tool must declare a has_tool_call stop condition, or no turn it runs could end by answering.',
    { tool_choice: args.toolChoice }
  );
};

/**
 * The steps a turn has already spent before the segment about to run — zero on
 * a fresh turn, the paused turn's step count on a resume after
 * `submit-tool-outputs`.
 */
const readStepsAlreadySpent = (value: unknown): number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : 0;
};

/**
 * Whether the turn's step budget is gone before its next segment starts.
 *
 * A pause and the last allowed step can coincide — the step that calls the
 * client tool may also be the one that spends the budget — so the caller must
 * be able to end such a turn without a model call. Granting it "just one more
 * step" instead would let a forced turn buy another call with every submit,
 * which is the unbounded turn the budget exists to prevent.
 */
export const isTurnBudgetSpent = (config: {
  maxSteps: unknown;
  stepsAlreadySpent: unknown;
}): boolean => {
  return (
    readStepsAlreadySpent(config.stepsAlreadySpent) >=
    resolveMaxSteps(config.maxSteps)
  );
};

/**
 * Every stop condition this turn runs under: the step budget, plus whatever the
 * agent declared. `max_steps` always stays in the list — a declared condition
 * narrows when the loop ends, it never lets the loop run longer — and it is
 * defaulted through `resolveMaxSteps` so every path agrees on the budget.
 *
 * `stepsAlreadySpent` is what makes that budget the *turn's* rather than one
 * segment's: a resume after `submit-tool-outputs` continues the same turn, so
 * counting from zero there would give every resumption a fresh `max_steps`.
 * Callers must rule out a spent budget with {@link isTurnBudgetSpent} first —
 * the remaining count is handed to `isStepCount`, which compares for equality
 * and so would never fire on zero.
 *
 * `tool_name` is the tool's **resolved** name (`modules/agents.md` — Tool Name
 * Resolution), which is the key `resolvedTools` is already built under, so no
 * id→name translation belongs here.
 *
 * Only `has_tool_call` is a per-turn predicate. `max_chain_generations` bounds
 * the chain rather than the turn, and is enforced where a continuation is
 * spawned (`generationChain.ts`, via {@link resolveChainGenerationCeiling}).
 * Every other entry is skipped rather than thrown on: writes refuse a type
 * outside the vocabulary, so failing a generation over one would be worse than
 * ignoring a condition no write path can produce.
 */
export const resolveStopWhen = (config: {
  maxSteps: unknown;
  stopConditions: unknown;
  stepsAlreadySpent?: unknown;
}): Array<StopCondition<ToolSet>> => {
  const conditions: Array<StopCondition<ToolSet>> = [
    isStepCount(
      Math.max(
        1,
        resolveMaxSteps(config.maxSteps) -
          readStepsAlreadySpent(config.stepsAlreadySpent)
      )
    ),
  ];

  if (!Array.isArray(config.stopConditions)) return conditions;

  for (const entry of config.stopConditions) {
    if (!isPlainObject(entry)) continue;
    const toolName = readToolName(entry);
    if (readType(entry) === 'has_tool_call' && toolName) {
      conditions.push(hasToolCall<ToolSet>(toolName));
    }
  }

  return conditions;
};

/**
 * The 1-indexed turn step that must answer without tools, or `null` when none
 * must.
 *
 * An `output_schema` agent's answer is the object, so its last allowed step
 * runs under `tool_choice: "none"` and returns it from what the turn gathered.
 * A forcing `tool_choice` forbids that answer, so such an agent keeps its last
 * step and fails at the budget instead ({@link readTurnObject}).
 */
export const resolveAnswerStep = (config: {
  maxSteps: unknown;
  outputSchema: unknown;
  toolChoice: unknown;
}): number | null => {
  if (!isPlainObject(config.outputSchema)) return null;
  if (forcesATool(config.toolChoice)) return null;
  return resolveMaxSteps(config.maxSteps);
};

const maxStepsReached = (maxSteps: number): DomainError => {
  return new DomainError(
    'MAX_STEPS_REACHED',
    `The turn spent all ${maxSteps} steps of max_steps without producing the output_schema object.`,
    { max_steps: maxSteps }
  );
};

/**
 * The turn's `output_schema` object, or `undefined` for an agent without one.
 *
 * A turn that spent its whole budget without producing the object fails with
 * `MAX_STEPS_REACHED`, naming the budget, rather than the SDK's bare
 * `No output generated`.
 */
export const readTurnObject = (args: {
  budget: TurnBudget;
  /** Every step the turn spent, across its pauses. */
  stepCount: number;
  readOutput: () => unknown;
}): unknown => {
  if (!isPlainObject(args.budget.outputSchema)) return undefined;
  try {
    const output = args.readOutput();
    if (output !== undefined) return output;
  } catch (error) {
    if (!NoOutputGeneratedError.isInstance(error)) throw error;
  }
  const maxSteps = resolveMaxSteps(args.budget.maxSteps);
  if (args.stepCount < maxSteps) throw new NoOutputGeneratedError();
  throw maxStepsReached(maxSteps);
};

/**
 * The error a failed `generateText` call of a turn fails with.
 *
 * An `output_schema` agent's model can answer under a forcing `tool_choice`
 * (the provider's structured-output channel), which `ai` refuses as a
 * `ToolChoiceViolationError`. On the last allowed step that refusal leaves the
 * budget spent without the object, so it fails as {@link readTurnObject} does.
 */
export const toTurnFailure = (args: {
  budget: TurnBudget;
  /** Every step the turn spent, across its pauses, the failing one included. */
  stepCount: number;
  error: unknown;
}): unknown => {
  const maxSteps = resolveMaxSteps(args.budget.maxSteps);
  if (
    isPlainObject(args.budget.outputSchema) &&
    ToolChoiceViolationError.isInstance(args.error) &&
    args.stepCount >= maxSteps
  ) {
    const failure = maxStepsReached(maxSteps);
    failure.cause = args.error;
    return failure;
  }
  return toProviderDomainError(args.error) ?? args.error;
};

/**
 * The largest chain the agent will let itself grow, or `null` when it declares
 * no ceiling. The **smallest** declared number wins if several are present: the
 * field is a list of things that stop the work, so more entries can only stop it
 * sooner.
 *
 * Read from the agent's current config at spawn time rather than captured on the
 * chain, for the same reason `on_approval_expiry` is: a chain can span days, and
 * what its owner wants applied is the number as it stands now — lowering it has
 * to be able to stop a chain that is already running away.
 */
export const resolveChainGenerationCeiling = (
  stopConditions: unknown
): number | null => {
  if (!Array.isArray(stopConditions)) return null;

  let ceiling: number | null = null;
  for (const entry of stopConditions) {
    if (!isPlainObject(entry)) continue;
    if (readType(entry) !== 'max_chain_generations') continue;
    const declared = readMaxGenerations(entry);
    if (declared === null) continue;
    ceiling = ceiling === null ? declared : Math.min(ceiling, declared);
  }
  return ceiling;
};
