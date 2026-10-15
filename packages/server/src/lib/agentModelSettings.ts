/**
 * The per-call model settings an agent sends with every step of a turn:
 * `temperature`, `max_output_tokens` and `reasoning`.
 *
 * `reasoning.effort` is the AI SDK's portable reasoning level, translated by
 * each provider package (Anthropic thinking, Gemini thinking config, OpenAI
 * reasoning effort) against what the model supports; a model that cannot
 * reason drops it with a warning rather than failing the call.
 */
import type { CallSettings } from 'ai';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const isReasoningEffort = (value: unknown): value is ReasoningEffort => {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value);
};

/**
 * The spec types both fields and refuses unknown `reasoning` keys; what it
 * cannot express — the floor, the effort vocabulary, a missing effort — is
 * refused here.
 */
export const assertValidMaxOutputTokens = (value: unknown): void => {
  if (typeof value === 'number' && value < 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "'max_output_tokens' must be a positive integer or null."
    );
  }
};

export const assertValidReasoning = (value: unknown): void => {
  if (value === null || value === undefined) return;
  if (!isPlainObject(value) || !isReasoningEffort(value.effort)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'reasoning' must be { "effort": ${REASONING_EFFORTS.map((effort) => {
        return `"${effort}"`;
      }).join(' | ')} } or null.`
    );
  }
};

/**
 * The settings for `generateText` / `streamText`. Each is omitted when unset,
 * which leaves the model's own default in force. Stored values are read
 * defensively: an archived config or a paused turn's frozen copy may predate
 * a field.
 */
export const modelCallSettings = (args: {
  temperature: unknown;
  maxOutputTokens?: unknown;
  reasoning?: unknown;
}): Pick<CallSettings, 'temperature' | 'maxOutputTokens' | 'reasoning'> => {
  const effort = isPlainObject(args.reasoning)
    ? args.reasoning.effort
    : undefined;
  return {
    ...(typeof args.temperature === 'number'
      ? { temperature: args.temperature }
      : {}),
    ...(typeof args.maxOutputTokens === 'number'
      ? { maxOutputTokens: args.maxOutputTokens }
      : {}),
    ...(isReasoningEffort(effort) ? { reasoning: effort } : {}),
  };
};
