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
 * All of them are key-blind: they read `role` and, for system content,
 * `content`, so a message's provider-specific payload travels through
 * untouched (`.claude/rules/case-convention.md`).
 */

/** Mirrors the AI SDK's `SystemModelMessage`: system content is a string. */
type SystemModelMessage = { role: 'system'; content: string };

/**
 * Mirrors the AI SDK's `Instructions`. The array form is what makes this
 * lossless: more than one system message needs no merge and no precedence rule,
 * because the SDK carries them ordered.
 */
export type Instructions = string | SystemModelMessage[];

type RoledMessage = { role?: unknown; content?: unknown };

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
 */
export const collectSystemInstructions = (
  messages: readonly unknown[]
): Instructions | undefined => {
  const contents = messages
    .filter(isSystem)
    .map((message) => {
      return (message as RoledMessage).content;
    })
    .filter((content): content is string => {
      return typeof content === 'string';
    });

  if (contents.length === 0) return undefined;
  if (contents.length === 1) return contents[0];

  return contents.map((content) => {
    return { role: 'system' as const, content };
  });
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
