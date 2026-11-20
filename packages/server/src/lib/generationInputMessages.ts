import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import { countOf, type GenerationProvenance } from './generationProvenance';
import {
  type ResolvableMessageContent,
  resolveMessageContent,
} from './messageContent';
import { withoutSystemMessages } from './modelMessages';
import type { WorkAuthority } from './workAuthority';

export type GenerationInputMessage = {
  role: string;
  content: ResolvableMessageContent | unknown;
};

/**
 * The provider refuses a prompt whose only content is system instructions, so a
 * turn with nothing to answer is the caller's error, refused before it is
 * recorded rather than failed by the provider.
 */
export const assertTurnHasMessage = (args: {
  messages: GenerationInputMessage[];
}): void => {
  if (withoutSystemMessages(args.messages).length > 0) return;
  throw new DomainError(
    'NO_MESSAGE_TO_ANSWER',
    'The turn has no message to answer. Add a message, then generate again.'
  );
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
  agentAuthority?: AgentAuthority;
  // The generation's identity-pinned `tool_context`, so a `tool_output` block
  // resolves its tool's `{{context:}}` headers and presets from the same bag
  // the model's own tool calls use.
  toolContext?: Record<string, string>;
  /** Where a `tool_output` or `document` block entering the turn is counted. */
  provenance: GenerationProvenance;
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
        agentAuthority: args.agentAuthority,
        toolContext: args.toolContext,
      });
      args.provenance.record(countOf(resolvedContent.provenance ?? null));

      return {
        role: message.role,
        content: resolvedContent.content,
      };
    })
  );

  return resolved;
};
