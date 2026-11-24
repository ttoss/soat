import { DomainError } from 'src/errors';
import { hasSystemMessage } from 'src/lib/modelMessages';

/**
 * The single rule for system content on the wire: it never travels as a
 * message. Chat completions refuse a `role: "system"` entry in `messages` with
 * this 400 and point at `instructions`; the request schemas of agent
 * generations and conversation messages carry no `system` role at all.
 *
 * This mirrors the AI SDK, whose `allowSystemInMessages` defaults to false and
 * throws rather than lifting or stripping — a system entry inside a
 * caller-supplied array is a prompt-injection vector, and honoring it lets
 * request data rewrite configured prompts.
 *
 * REST boundary only: internal callers below this line legitimately assemble
 * system content themselves, so the lib layer must not repeat this check.
 */
export const assertNoSystemMessage = (args: {
  messages: unknown;
  remedy: string;
}): void => {
  if (!Array.isArray(args.messages)) return;
  if (!hasSystemMessage(args.messages)) return;

  throw new DomainError(
    'SYSTEM_MESSAGE_NOT_ALLOWED',
    `A system message is not accepted in \`messages\`. ${args.remedy}`
  );
};
