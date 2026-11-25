import type { AuthUser } from '../Context';
import { DomainError } from '../errors';
import type { AgentAuthority } from './agentAuthority';
import { countOf, type GenerationProvenance } from './generationProvenance';
import {
  isDocumentMessageContent,
  isToolOutputMessageContent,
  type ResolvableMessageContent,
  resolveMessageContent,
} from './messageContent';
import {
  type FileMessageContentPart,
  isFileMessageContentPart,
  resolveFileContentPart,
} from './messageFileParts';
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
    'The turn has no message to answer.'
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
type ResolveArgs = {
  turnProjectId: number;
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
};

/** A file part, which a model reads only in a `user` message. */
const resolveFilePart = (
  args: ResolveArgs & { part: FileMessageContentPart; role: string }
) => {
  if (args.role !== 'user') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'A `file` part is accepted only in a `user` message.'
    );
  }
  return resolveFileContentPart(args);
};

/**
 * A `document` or `tool_output` block as text, or as parts when its tool
 * returns files, each read like a `file` part the caller names.
 */
const resolveContent = async (
  args: ResolveArgs & { content: ResolvableMessageContent; role: string }
): Promise<string | unknown[]> => {
  const resolved = await resolveMessageContent({
    content: args.content,
    turnProjectId: args.turnProjectId,
    projectIds: args.projectIds,
    authority: args.authority,
    authUser: args.authUser,
    allowedToolIds: args.allowedToolIds,
    agentAuthority: args.agentAuthority,
    toolContext: args.toolContext,
  });
  args.provenance.record(countOf(resolved.provenance ?? null));
  if (!resolved.parts) return resolved.content;
  return Promise.all(
    resolved.parts.map((part) => {
      return part.type === 'file' ? resolveFilePart({ ...args, part }) : part;
    })
  );
};

/**
 * A part the caller names (`file`, `document`, `tool_output`) becomes the
 * parts the model reads; any other part is already in AI SDK form (a tool
 * call, a tool result, a text part) and passes through.
 */
const resolvePart = async (
  args: ResolveArgs & { part: unknown; role: string }
): Promise<unknown[]> => {
  const { part } = args;
  if (isFileMessageContentPart(part)) {
    return [await resolveFilePart({ ...args, part })];
  }
  if (isDocumentMessageContent(part) || isToolOutputMessageContent(part)) {
    const content = await resolveContent({ ...args, content: part });
    return typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content;
  }
  return [part];
};

export const resolveGenerationInputMessages = async (
  args: ResolveArgs
): Promise<Array<{ role: string; content: unknown }>> => {
  return Promise.all(
    args.messages.map(async (message) => {
      if (Array.isArray(message.content)) {
        const parts: unknown[] = message.content;
        return {
          role: message.role,
          content: (
            await Promise.all(
              parts.map((part) => {
                return resolvePart({ ...args, part, role: message.role });
              })
            )
          ).flat(),
        };
      }
      return {
        role: message.role,
        content: await resolveContent({
          ...args,
          content: message.content as ResolvableMessageContent,
          role: message.role,
        }),
      };
    })
  );
};
