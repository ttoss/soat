import type { AuthUser } from '../Context';
import type { db } from '../db';
import { DomainError } from '../errors';
import {
  addConversationDocumentMessage,
  addConversationMessage,
} from './conversationMessages';
import { countOf } from './generationProvenance';
import { resolveMessageContent } from './messageContent';
import { principalFromAuthUser, type RequestPrincipal } from './principals';
import type { WorkAuthority } from './workAuthority';
import { captureAuthority } from './workAuthority';

/** A session turn is text, files, both, or one document: never document and more. */
export const assertSessionMessageInput = (args: {
  message?: string;
  documentId?: string;
  fileIds?: string[];
}) => {
  const hasFiles = (args.fileIds?.length ?? 0) > 0;
  if (!args.message && !args.documentId && !hasFiles) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'one of message, file_ids or document_id is required'
    );
  }
  if (args.documentId && (args.message || hasFiles)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'document_id is mutually exclusive with message and file_ids'
    );
  }
};

/** Who a session message's embedding acts as: its caller, when it has one. */
const principalOf = (
  authUser: AuthUser | undefined
): RequestPrincipal | null => {
  return authUser ? principalFromAuthUser(authUser) : null;
};

export const addResolvedSessionUserMessage = async (args: {
  conversationId: string;
  projectId: number;
  actorId?: string | null;
  message?: string;
  documentId?: string;
  fileIds?: string[];
  authUser?: AuthUser;
  idempotencyKey?: string;
  idempotencyDigest?: string;
}) => {
  const resolvedContent = await resolveMessageContent({
    turnProjectId: args.projectId,
    authority: captureAuthority({ authUser: args.authUser }),
    content: args.documentId
      ? { type: 'document', document_id: args.documentId }
      : (args.message ?? ''),
    authUser: args.authUser,
  });

  const provenance = countOf(resolvedContent.provenance ?? null);
  const userMsg = args.documentId
    ? await addConversationDocumentMessage({
        conversationId: args.conversationId,
        documentId: args.documentId,
        role: 'user',
        actorId: args.actorId ?? null,
        idempotencyKey: args.idempotencyKey,
        idempotencyDigest: args.idempotencyDigest,
        provenance,
      })
    : await addConversationMessage({
        conversationId: args.conversationId,
        message: resolvedContent.content,
        role: 'user',
        files: args.fileIds?.length
          ? {
              ids: args.fileIds,
              authority: captureAuthority({ authUser: args.authUser }),
              authUser: args.authUser,
            }
          : undefined,
        actorId: args.actorId ?? null,
        idempotencyKey: args.idempotencyKey,
        idempotencyDigest: args.idempotencyDigest,
        provenance,
        embedAs: principalOf(args.authUser),
      });

  if (!userMsg) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  return { resolvedContent, userMsg };
};

type SessionRecord = InstanceType<(typeof db)['Session']> | null;

export type GenerateSessionResponseFn = (args: {
  agentId: number;
  sessionId: string;
  toolContext?: Record<string, string>;
  authority: WorkAuthority | null;
  authUser: AuthUser | undefined;
  initiatorGenerationId?: string | null;
}) => Promise<unknown>;

export const triggerOrReturnMessage = (args: {
  session: SessionRecord;
  agentId: number;
  sessionId: string;
  toolContext?: Record<string, string>;
  authority: WorkAuthority | null;
  authUser: AuthUser | undefined;
  savedContent: string | null;
  savedDocumentId: string | undefined;
  generateFn: GenerateSessionResponseFn;
  // The generation this turn continues, when a resumption drove it (an
  // approval's continuation). Declares the chain so it is bounded and linked;
  // a person's own message leaves it unset.
  initiatorGenerationId?: string | null;
}) => {
  if (args.session?.autoGenerate && !args.session.generatingAt) {
    return args.generateFn({
      agentId: args.agentId,
      sessionId: args.sessionId,
      toolContext: args.toolContext,
      authority: args.authority,
      authUser: args.authUser,
      initiatorGenerationId: args.initiatorGenerationId,
    });
  }
  return {
    role: 'user' as const,
    content: args.savedContent,
    document_id: args.savedDocumentId,
  };
};
