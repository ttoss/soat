/**
 * The system/non-system split every provider call performs.
 *
 * The AI SDK takes system content as its own `instructions` argument rather than
 * as a message, so every call site has to lift system content out and pass the
 * rest as `messages`. That is not a style preference — `standardizePrompt`
 * refuses a system message left in `messages`:
 *
 *   allowSystemInMessages = false            // the default
 *   → InvalidPromptError: 'System messages are not allowed in the prompt or
 *     messages fields. Use the instructions option instead.'
 *
 * The split was written out nine times across `agentGeneration`,
 * `agentNonStreamGeneration`, `agentGenerationHelpers` and `chats` — and two of
 * those sites read the system message from a *different* array than the one they
 * filter (a resumed turn takes its instructions from the persisted history but
 * sends the history plus the new tool results), which is why this is composable
 * functions rather than one that returns both.
 *
 * All of them are key-blind: they read `role` and, for system content, `content`.
 * Nothing else is inspected or rewritten, so a message's provider-specific
 * payload travels through untouched (`.claude/rules/case-convention.md`).
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
 * value: `undefined` when there is none, the bare string when there is one, and
 * an ordered array when there are several.
 *
 * The previous helper read `.find` — the *first* system message — while the
 * filter beside it removed *all* of them, so every system message after the
 * first was silently destroyed. Whether a caller's system message reached the
 * model therefore depended on whether an earlier one already occupied the slot.
 *
 * Content that is not a plain string cannot be an instruction (providers accept
 * only a string there, and `SystemModelMessage` types it that way), so it is
 * skipped here rather than coerced. It is not lost silently: the surfaces that
 * must not receive system content at all use {@link hasSystemMessage} to reject
 * the request outright.
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
