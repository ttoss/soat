/**
 * The system/non-system split every provider call performs.
 *
 * The AI SDK takes the system prompt as its own `instructions` argument rather
 * than as a message, so every call site has to lift the system message out and
 * pass the rest as `messages`. That split was written out nine times across
 * `agentGeneration`, `agentNonStreamGeneration`, `agentGenerationHelpers` and
 * `chats` — and two of those sites read the system message from a *different*
 * array than the one they filter (a resumed turn takes its instructions from
 * the persisted history but sends the history plus the new tool results), which
 * is why this is two composable functions rather than one that returns both.
 *
 * Both are key-blind: they read `role` and, for the system message, `content`.
 * Neither inspects or rewrites any other key, so a message's provider-specific
 * payload travels through untouched (`.claude/rules/case-convention.md`).
 */

type RoledMessage = { role?: unknown; content?: unknown };

const isSystem = (message: unknown): boolean => {
  return (message as RoledMessage | null)?.role === 'system';
};

/**
 * The system prompt to pass as `instructions`, or `undefined` when the history
 * carries no system message (or one whose content is not a plain string — the
 * providers only accept a string here).
 */
export const findSystemInstructions = (
  messages: readonly unknown[]
): string | undefined => {
  const content = (messages.find(isSystem) as RoledMessage | undefined)
    ?.content;
  return typeof content === 'string' ? content : undefined;
};

/** The history minus its system message, i.e. what goes in `messages`. */
export const withoutSystemMessages = <T>(messages: readonly T[]): T[] => {
  return messages.filter((message) => {
    return !isSystem(message);
  });
};
