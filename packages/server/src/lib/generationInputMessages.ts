import type { AuthUser } from '../Context';
import {
  type ResolvableMessageContent,
  resolveMessageContent,
} from './messageContent';

export type GenerationInputMessage = {
  role: string;
  content: ResolvableMessageContent;
};

export const resolveGenerationInputMessages = async (args: {
  projectIds?: number[];
  messages: GenerationInputMessage[];
  authHeader?: string;
  authUser?: AuthUser;
  allowedToolIds?: string[];
  agentBoundaryPolicy?: unknown;
}): Promise<Array<{ role: string; content: string }>> => {
  const resolved = await Promise.all(
    args.messages.map(async (message) => {
      const resolvedContent = await resolveMessageContent({
        content: message.content,
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
