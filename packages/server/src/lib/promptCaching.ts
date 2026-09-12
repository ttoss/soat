/**
 * Where a turn's prompt-cache breakpoint goes, and what marks it.
 *
 * A provider that caches by explicit breakpoint (Anthropic, and Anthropic
 * models served through Bedrock) caches the request *prefix* up to the marked
 * block. The prefix is ordered tools → system → messages, so one mark at the
 * end of the system block covers the tool definitions and the instructions
 * together — the whole of what stays byte-identical across the steps of a turn
 * and across the turns of a session. Everything after it is the conversation,
 * which grows every step and is what the prefix cache exists to stop re-buying.
 *
 * One mark, not one per block. Nested breakpoints each open their own cache
 * entry, and what a write of overlapping prefixes is billed as is a provider
 * detail we would be guessing at; one prefix has one write and one read, which
 * is arithmetic an operator can check against their invoice.
 *
 * Caching is off unless the agent asks for it: a cache write costs more than an
 * uncached token, so an agent whose prefix is never re-read would pay for the
 * privilege.
 */
import type { SystemModelMessage } from 'ai';

import { DomainError } from '../errors';
import { isPlainObject } from './plainObject';

export type PromptCachingConfig = { enabled: boolean };

/**
 * The breakpoint, in every spelling the providers that honour one read.
 *
 * Both are always emitted rather than branching on the agent's provider: a
 * `model_route` picks its provider per attempt, so there is no one provider to
 * branch on at the time the prompt is assembled. Each provider reads only its
 * own key and ignores the rest, so the unread spellings cost nothing — and a
 * provider that caches automatically (OpenAI) or not at all is unaffected.
 */
const CACHE_BREAKPOINT: SystemModelMessage['providerOptions'] = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
  bedrock: { cachePoint: { type: 'default' } },
};

/** The `prompt_caching` key set a write may set. */
const PROMPT_CACHING_KEYS = new Set(['enabled']);

/**
 * Reads an agent's stored `prompt_caching`. Absent, malformed or `enabled`
 * anything but `true` reads as off: the column is untyped JSON, and the
 * failure mode of guessing "on" is a bill, not a broken turn.
 */
export const readPromptCachingConfig = (
  value: unknown
): PromptCachingConfig => {
  if (!isPlainObject(value)) return { enabled: false };
  return { enabled: value.enabled === true };
};

/**
 * Rejects a `prompt_caching` a write cannot mean. Unknown keys are refused
 * rather than ignored so a typo surfaces as a `400` instead of an agent that
 * reads as caching-enabled to its author and never caches.
 */
export const assertValidPromptCaching = (value: unknown): void => {
  if (value === null || value === undefined) return;

  if (!isPlainObject(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "'prompt_caching' must be an object."
    );
  }

  const unknown = Object.keys(value).filter((key) => {
    return !PROMPT_CACHING_KEYS.has(key);
  });
  if (unknown.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'prompt_caching' has no such field(s): ${unknown.join(', ')}.`
    );
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new DomainError(
      'VALIDATION_FAILED',
      "'prompt_caching.enabled' must be a boolean."
    );
  }
};

/**
 * Marks the turn's static prefix, by hanging the breakpoint off the last system
 * message.
 *
 * The returned array is what the generation persists, so a turn that pauses for
 * an approval or a client tool and resumes hours later replays the same
 * breakpoint rather than re-deriving one from an agent that may since have been
 * edited.
 *
 * An agent with no `instructions` contributes no system message and so has no
 * block to mark: its tool definitions stay uncached. Marking the first user
 * message instead would cache a prefix that includes the turn's own question,
 * which never repeats.
 */
export const withPromptCacheBreakpoint = <
  T extends { role: string; content: unknown },
>(args: {
  promptCaching: unknown;
  messages: T[];
}): T[] => {
  if (!readPromptCachingConfig(args.promptCaching).enabled) {
    return args.messages;
  }

  const lastSystemIndex = args.messages.findLastIndex((message) => {
    return message.role === 'system';
  });
  if (lastSystemIndex === -1) return args.messages;

  return args.messages.map((message, index) => {
    if (index !== lastSystemIndex) return message;
    return { ...message, providerOptions: CACHE_BREAKPOINT };
  });
};
