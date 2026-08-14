import type { AuthUser } from '../Context';
import {
  type ResolvableMessageContent,
  resolveMessageContent,
} from './messageContent';

export type GenerationInputMessage = {
  role: string;
  content: ResolvableMessageContent | unknown;
};

/**
 * Resolves the messages of an agent generation, whoever assembled them.
 *
 * Note this is **not** the request boundary: internal callers reach it with
 * system content they built themselves and legitimately own — a session
 * generation arrives through `conversationGeneration`, which prepends the actor
 * persona as a `role: "system"` message. Refusing system content here would
 * reject those flows, so the check that an agent's system prompt is only its
 * `instructions` field lives at the REST boundary
 * (`assertNoSystemMessage` in `rest/v1/agentGeneration.ts`), where the array is
 * known to have come from the request.
 */
export const resolveGenerationInputMessages = async (args: {
  projectIds?: number[];
  messages: GenerationInputMessage[];
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentBoundaryPolicy?: unknown;
}): Promise<Array<{ role: string; content: unknown }>> => {
  const resolved = await Promise.all(
    args.messages.map(async (message) => {
      // Array content is already in AI SDK format (tool calls, tool results) — pass through.
      if (Array.isArray(message.content)) {
        return { role: message.role, content: message.content };
      }

      const resolvedContent = await resolveMessageContent({
        content: message.content as ResolvableMessageContent,
        projectIds: args.projectIds,
        authHeader: args.authHeader,
        authUser: args.authUser,
        allowedToolIds: args.allowedToolIds,
        agentBoundaryPolicy: args.agentBoundaryPolicy,
      });

      return {
        role: message.role,
        content: resolvedContent.content,
      };
    })
  );

  return resolved;
};
