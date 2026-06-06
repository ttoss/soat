import type { AuthUser } from '../Context';
import {
  type ResolvableMessageContent,
  resolveMessageContent,
} from './messageContent';

export type GenerationInputMessage = {
  role: string;
  content: ResolvableMessageContent | unknown[];
};

export const resolveGenerationInputMessages = async (args: {
  projectIds?: number[];
  messages: Array<{ role: string; content: ResolvableMessageContent | unknown[] }>;
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentBoundaryPolicy?: unknown;
}): Promise<Array<{ role: string; content: unknown }>> => {
  const resolved = await Promise.all(
    args.messages.map(async (message) => {
      // Pass through complex content (e.g. AI SDK tool messages) without resolution
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
