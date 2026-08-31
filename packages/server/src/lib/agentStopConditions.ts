/**
 * The agent's `stop_conditions`, resolved into the AI SDK `stopWhen` array the
 * generation loop actually runs under.
 *
 * The field is documented (`modules/agents.md` — Stop Conditions) and was
 * reaching nothing: every `stopWhen` was `isStepCount(maxSteps)` alone, so the
 * "done tool" idiom the docs describe terminated the loop only by accident of
 * the model choosing to stop. Same shape as #811, where `active_tool_ids` was
 * stored, versioned and silently ignored.
 *
 * Resolved in one place for all three call sites — the fresh turn, its no-tools
 * retry, and the resume after `submit-tool-outputs` — because two sites
 * deriving the same thing independently is exactly how #1163's bug survived in
 * both at once.
 */
import { hasToolCall, isStepCount, type StopCondition, type ToolSet } from 'ai';
import createDebug from 'debug';

import { DomainError } from '../errors';
import { resolveMaxSteps } from './generationStopReason';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:generation');

/** The condition vocabulary. One entry today; the shape is the extension point. */
export const STOP_CONDITION_TYPES = ['hasToolCall'] as const;

const KNOWN_TYPES: ReadonlySet<string> = new Set(STOP_CONDITION_TYPES);

const readType = (entry: Record<string, unknown>): string | null => {
  return typeof entry.type === 'string' ? entry.type : null;
};

const readToolName = (entry: Record<string, unknown>): string | null => {
  return typeof entry.tool_name === 'string' && entry.tool_name.length > 0
    ? entry.tool_name
    : null;
};

const invalid = (
  message: string,
  meta: Record<string, unknown>
): DomainError => {
  return new DomainError('VALIDATION_FAILED', message, meta);
};

/**
 * Rejects a `stop_conditions` value the loop could not act on, so a typo is a
 * `400` on write rather than a condition that never fires. An unknown `type` is
 * refused here even though {@link resolveStopWhen} tolerates one at runtime: a
 * stored row may predate this check, but accepting a *new* write of one is what
 * made the field inert in the first place.
 */
export const assertValidStopConditions = (value: unknown): void => {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw invalid('stop_conditions must be an array.', {
      stopConditions: value,
    });
  }

  for (const entry of value) {
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
    if (type === 'hasToolCall' && !readToolName(entry)) {
      throw invalid(
        'A hasToolCall stop condition requires a non-empty tool_name.',
        { condition: entry }
      );
    }
  }
};

/**
 * Every stop condition this turn runs under: the step budget, plus whatever the
 * agent declared. `max_steps` always stays in the list — a declared condition
 * narrows when the loop ends, it never lets the loop run longer — and it is
 * defaulted through `resolveMaxSteps` so every path agrees on the budget.
 *
 * `tool_name` is the tool's **resolved** name (`modules/agents.md` — Tool Name
 * Resolution), which is the key `resolvedTools` is already built under, so no
 * id→name translation belongs here.
 *
 * An entry the vocabulary does not cover is skipped with a log rather than
 * throwing: writes are validated, so anything reaching here is a stored row
 * from before that validation, and failing its generation would be worse than
 * ignoring a condition that never fired anyway.
 */
export const resolveStopWhen = (config: {
  maxSteps: unknown;
  stopConditions: unknown;
}): Array<StopCondition<ToolSet>> => {
  const conditions: Array<StopCondition<ToolSet>> = [
    isStepCount(resolveMaxSteps(config.maxSteps)),
  ];

  if (!Array.isArray(config.stopConditions)) return conditions;

  for (const entry of config.stopConditions) {
    if (!isPlainObject(entry)) continue;
    const toolName = readToolName(entry);
    if (readType(entry) === 'hasToolCall' && toolName) {
      conditions.push(hasToolCall<ToolSet>(toolName));
      continue;
    }
    log('resolveStopWhen: ignoring unsupported condition %o', entry);
  }

  return conditions;
};
