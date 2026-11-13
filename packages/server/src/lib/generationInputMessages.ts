import type { AuthUser } from '../Context';
import type { AgentBoundary } from './agentBoundary';
import {
  type ResolvableMessageContent,
  resolveMessageContent,
} from './messageContent';
import type { WorkAuthority } from './workAuthority';

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
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentBoundary?: AgentBoundary;
  // The generation's identity-pinned `tool_context`, so a `tool_output` block
  // resolves its tool's `{{context:}}` headers and presets from the same bag
  // the model's own tool calls use.
  toolContext?: Record<string, string>;
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
        authority: args.authority,
        authUser: args.authUser,
        allowedToolIds: args.allowedToolIds,
        agentBoundary: args.agentBoundary,
        toolContext: args.toolContext,
      });

      return {
        role: message.role,
        content: resolvedContent.content,
      };
    })
  );

  return resolved;
};
