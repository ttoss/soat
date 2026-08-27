import { DomainError } from 'src/errors';
import { hasSystemMessage } from 'src/lib/modelMessages';

/**
 * The single rule for system content on the wire: it never travels as a
 * message. Every REST surface accepting a caller-supplied `messages` array
 * refuses a `role: "system"` entry with the same 400 and points at that
 * surface's dedicated channel.
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

/**
 * The same rule for endpoints that take one message at a time (a conversation's
 * add-message). A stored system message would flow into generation history and
 * be lifted into the model's instructions, so the door is closed where the
 * message enters.
 */
export const assertNotSystemRole = (args: {
  role: unknown;
  remedy: string;
}): void => {
  if (args.role !== 'system') return;

  throw new DomainError(
    'SYSTEM_MESSAGE_NOT_ALLOWED',
    `A system message is not accepted here. ${args.remedy}`
  );
};
