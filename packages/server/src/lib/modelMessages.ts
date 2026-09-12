/**
 * The system/non-system split every provider call performs.
 *
 * The AI SDK takes system content as its own `instructions` argument, and
 * `standardizePrompt` refuses a system message left in `messages`
 * (`allowSystemInMessages` defaults to false), so every call site has to lift
 * it out. The split was written out nine times across `agentGeneration`,
 * `agentNonStreamGeneration`, `agentGenerationHelpers` and `chats` — two of
 * them reading the system message from a *different* array than the one they
 * filter, which is why this is composable functions rather than one returning
 * both.
 *
 * All of them are key-blind apart from `providerOptions`, which the SDK itself
 * defines on a system message and which carries the prompt-cache breakpoint: a
 * message's other provider-specific payload travels through untouched
 * (`.claude/rules/case-convention.md`).
 */
import type { SystemModelMessage } from 'ai';

/**
 * Mirrors the AI SDK's `Instructions`. The array form is what makes this
 * lossless: more than one system message needs no merge and no precedence rule,
 * because the SDK carries them ordered — and it is the only form that can carry
 * a `providerOptions`, which is where a prompt-cache breakpoint lives.
 */
export type Instructions = string | SystemModelMessage[];

type RoledMessage = {
  role?: unknown;
  content?: unknown;
  providerOptions?: SystemModelMessage['providerOptions'];
};

const isSystem = (message: unknown): boolean => {
  return (message as RoledMessage | null)?.role === 'system';
};

/**
 * Every system message in the history, in order, as the SDK's `instructions`
 * value: `undefined` for none, the bare string for one, an ordered array for
 * several.
 *
 * The previous helper read the *first* system message while the filter beside
 * it removed *all* of them, so every one after the first was silently
 * destroyed. Non-string content cannot be an instruction (providers accept only
 * a string), so it is skipped rather than coerced; surfaces that must reject
 * system content outright use {@link hasSystemMessage}.
 *
 * A `providerOptions` is carried across, because the prompt-cache breakpoint
 * lives on it: dropping it here would leave every cached agent silently
 * uncached, the failure mode the breakpoint exists to end.
 */
export const collectSystemInstructions = (
  messages: readonly unknown[]
): Instructions | undefined => {
  const systemMessages = messages
    .filter(isSystem)
    .flatMap((message): SystemModelMessage[] => {
      const { content, providerOptions } = message as RoledMessage;
      if (typeof content !== 'string') return [];
      return [
        providerOptions
          ? { role: 'system', content, providerOptions }
          : { role: 'system', content },
      ];
    });

  if (systemMessages.length === 0) return undefined;
  // The bare string is the SDK's own shorthand for the single-instruction case,
  // kept so the common call is unchanged on the wire. It cannot carry a
  // `providerOptions`, so a message that has one stays in its object form.
  if (systemMessages.length === 1 && !systemMessages[0].providerOptions) {
    return systemMessages[0].content;
  }

  return systemMessages;
};

/**
 * Whether the history carries a system message at all — including one whose
 * content is structured rather than a string, which
 * {@link collectSystemInstructions} cannot represent.
 *
 * Used by surfaces where system content is not the caller's to supply (an
 * agent's system prompt is its `instructions` field), so the request is refused
 * instead of having part of it quietly ignored.
 */
export const hasSystemMessage = (messages: readonly unknown[]): boolean => {
  return messages.some(isSystem);
};

/** The history minus its system messages, i.e. what goes in `messages`. */
export const withoutSystemMessages = <T>(messages: readonly T[]): T[] => {
  return messages.filter((message) => {
    return !isSystem(message);
  });
};
