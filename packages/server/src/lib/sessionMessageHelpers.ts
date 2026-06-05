import type { AuthUser } from '../Context';
import type { db } from '../db';
import { DomainError } from '../errors';
import {
  addConversationDocumentMessage,
  addConversationMessage,
} from './conversationMessages';
import { resolveMessageContent } from './messageContent';

export const assertSessionMessageInput = (args: {
  message?: string;
  documentId?: string;
}) => {
  if (!args.message && !args.documentId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'either message or documentId is required'
    );
  }
  if (args.message && args.documentId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'message and documentId are mutually exclusive'
    );
  }
};

export const addResolvedSessionUserMessage = async (args: {
  conversationId: string;
  actorId?: string | null;
  message?: string;
  documentId?: string;
  authUser?: AuthUser;
  idempotencyKey?: string;
}) => {
  const resolvedContent = await resolveMessageContent({
    content: args.documentId
      ? { type: 'document', documentId: args.documentId }
      : (args.message ?? ''),
    authUser: args.authUser,
  });

  const userMsg = args.documentId
    ? await addConversationDocumentMessage({
        conversationId: args.conversationId,
        documentId: args.documentId,
        role: 'user',
        actorId: args.actorId ?? null,
      })
    : await addConversationMessage({
        conversationId: args.conversationId,
        message: resolvedContent.content,
        role: 'user',
        actorId: args.actorId ?? null,
        idempotencyKey: args.idempotencyKey,
      });

  if (!userMsg) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  return { resolvedContent, userMsg };
};

type SessionRecord = InstanceType<(typeof db)['Session']> | null;

type GenerateFn = (args: {
  agentId: number;
  sessionId: string;
  toolContext?: Record<string, string>;
}) => Promise<unknown>;

export const triggerOrReturnMessage = (args: {
  session: SessionRecord;
  agentId: number;
  sessionId: string;
  toolContext?: Record<string, string>;
  savedContent: string | null;
  savedDocumentId: string | undefined;
  generateFn: GenerateFn;
}) => {
  if (args.session?.autoGenerate && !args.session.generatingAt) {
    return args.generateFn({
      agentId: args.agentId,
      sessionId: args.sessionId,
      toolContext: args.toolContext,
    });
  }
  return {
    role: 'user' as const,
    content: args.savedContent,
    documentId: args.savedDocumentId,
  };
};
