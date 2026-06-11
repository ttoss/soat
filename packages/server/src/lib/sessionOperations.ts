import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { submitToolOutputs } from './agents';
import { generateConversationMessage } from './conversationGeneration';
import { listConversationMessages } from './conversations';
import { triggerOrScheduleGeneration } from './sessionDelayHelpers';
import {
  emitGenerationCompleted,
  emitGenerationRequiresAction,
  emitGenerationStarted,
  processToolOutputResult,
} from './sessionGenerationHelpers';
import {
  addResolvedSessionUserMessage,
  assertSessionMessageInput,
} from './sessionMessageHelpers';

const GENERATING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── In-memory abort controller map ───────────────────────────────────────
// Key: `${agentId}#${sessionId}` — one controller per session.
// Used to cancel in-flight LLM calls when a new generation request arrives.
const sessionAbortControllers = new Map<string, AbortController>();

/**
 * Abort and remove the controller for the given session key, if one exists.
 * Safe to call when no controller is registered.
 */
export const abortSessionGeneration = (sessionKey: string) => {
  const existing = sessionAbortControllers.get(sessionKey);
  if (existing) {
    existing.abort();
    sessionAbortControllers.delete(sessionKey);
  }
};

const sessionIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Conversation, as: 'conversation' },
    { model: db.Actor, as: 'actor' },
  ];
};

/**
 * Internal helper that returns the raw Session model instance.
 */
export const findSessionRecord = async (args: {
  agentId: number;
  sessionId: string;
}): Promise<InstanceType<(typeof db)['Session']> | null> => {
  return db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
    include: sessionIncludes(),
  });
};

const buildToolContext = (
  session: InstanceType<(typeof db)['Session']>
): Record<string, string> => {
  const actor = (
    session as unknown as {
      actor?: InstanceType<(typeof db)['Actor']> | null;
    }
  ).actor;

  const context: Record<string, string> = {
    sessionId: session.publicId,
  };

  if (actor?.publicId) {
    context.actorId = actor.publicId;
  }

  if (actor?.externalId) {
    context.actorExternalId = actor.externalId;
  }

  return context;
};

/**
 * Abort any in-flight generation and check the DB-based concurrency guard.
 * Returns `'already_generating'` if the caller should bail out, `null` otherwise.
 */
const checkConcurrency = (args: {
  sessionKey: string;
  session: InstanceType<(typeof db)['Session']>;
}): 'already_generating' | null => {
  const hadExistingController = sessionAbortControllers.has(args.sessionKey);
  abortSessionGeneration(args.sessionKey);
  if (hadExistingController) {
    return null;
  }
  if (args.session.generatingAt) {
    const elapsed = Date.now() - new Date(args.session.generatingAt).getTime();
    if (elapsed < GENERATING_TIMEOUT_MS) {
      return 'already_generating';
    }
  }
  return null;
};

/**
 * Emit the appropriate event and build the return value from a generation result.
 */
const buildGenerationResult = (
  session: InstanceType<(typeof db)['Session']>,
  result: Awaited<ReturnType<typeof generateConversationMessage>>
) => {
  if (result.status === 'requires_action') {
    emitGenerationRequiresAction({
      session,
      generationId: result.generationId,
      traceId: result.traceId,
    });
    return {
      status: 'requires_action' as const,
      generationId: result.generationId,
      traceId: result.traceId,
      requiredAction: result.requiredAction,
    };
  }
  emitGenerationCompleted({
    session,
    generationId: result.generationId,
    traceId: result.traceId,
  });
  return {
    status: 'completed' as const,
    message: {
      role: 'assistant' as const,
      content: result.content,
      model: result.model,
    },
    generationId: result.generationId,
    traceId: result.traceId,
  };
};

const checkSessionExpiry = async (
  session: InstanceType<(typeof db)['Session']>
) => {
  const ttl = session.inactivityTtlSeconds;
  if (!ttl) {
    return;
  }
  const lastActivity = session.lastActivityAt ?? session.createdAt;
  const elapsed = Date.now() - new Date(lastActivity).getTime();
  if (elapsed > ttl * 1000) {
    if (session.status !== 'expired') {
      await session.update({ status: 'expired' });
    }
    throw new DomainError(
      'SESSION_EXPIRED',
      'The session has expired due to inactivity.'
    );
  }
};

export const generateSessionResponse = async (args: {
  agentId: number;
  sessionId: string;
  model?: string;
  toolContext?: Record<string, string>;
}) => {
  const session = await findSessionRecord({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  if (!session) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  if (session.status === 'closed') {
    throw new DomainError(
      'SESSION_CLOSED',
      'The session is closed. Open a new session to continue.'
    );
  }

  await checkSessionExpiry(session);

  const sessionKey = `${args.agentId}#${args.sessionId}`;
  const concurrencyResult = checkConcurrency({ sessionKey, session });
  if (concurrencyResult) {
    throw new DomainError(
      'GENERATION_ALREADY_IN_PROGRESS',
      'Generation already in progress'
    );
  }

  const conversation = session.conversation as InstanceType<
    (typeof db)['Conversation']
  >;
  const agent = (
    session as unknown as { agent?: InstanceType<(typeof db)['Agent']> }
  ).agent;

  if (!agent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  const mergedToolContext = {
    ...buildToolContext(session),
    ...(session.toolContext ?? {}),
    ...(args.toolContext ?? {}),
  };

  const controller = new AbortController();
  sessionAbortControllers.set(sessionKey, controller);
  await session.update({ generatingAt: new Date() });
  emitGenerationStarted(session);

  let result: Awaited<ReturnType<typeof generateConversationMessage>>;

  try {
    result = await generateConversationMessage({
      conversationId: conversation.publicId,
      agentId: agent.publicId,
      model: args.model,
      toolContext: mergedToolContext,
      abortSignal: controller.signal,
    });
  } finally {
    if (!controller.signal.aborted) {
      await session.update({ generatingAt: null });
    }
    if (sessionAbortControllers.get(sessionKey) === controller) {
      sessionAbortControllers.delete(sessionKey);
    }
  }

  return buildGenerationResult(session, result);
};

export const listSessionMessages = async (args: {
  agentId: number;
  sessionId: string;
  limit?: number;
  offset?: number;
}) => {
  const session = await findSessionRecord({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  if (!session) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  const conversation = session.conversation as InstanceType<
    (typeof db)['Conversation']
  >;

  const result = await listConversationMessages({
    conversationId: conversation.publicId,
    limit: args.limit,
    offset: args.offset,
  });

  const mappedData = result?.data.map((msg) => {
    return {
      role: msg.role,
      content: msg.content,
      documentId: msg.documentId,
      position: msg.position,
      metadata: msg.metadata,
    };
  });

  return {
    data: mappedData,
    total: result?.total,
    limit: result?.limit,
    offset: result?.offset,
  };
};

export const addSessionMessage = async (args: {
  agentId: number;
  sessionId: string;
  message?: string;
  documentId?: string;
  toolContext?: Record<string, string>;
  authUser?: AuthUser;
  idempotencyKey?: string;
}) => {
  const session = await findSessionRecord({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  if (!session) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  if (session.status === 'closed') {
    throw new DomainError(
      'SESSION_CLOSED',
      'The session is closed. Open a new session to continue.'
    );
  }

  if (session.status === 'expired') {
    throw new DomainError(
      'SESSION_EXPIRED',
      'The session has expired due to inactivity. Open a new session to continue.'
    );
  }

  const conversation = session.conversation as InstanceType<
    (typeof db)['Conversation']
  >;
  const actor = (
    session as unknown as {
      actor?: InstanceType<(typeof db)['Actor']> | null;
    }
  ).actor;

  assertSessionMessageInput({
    message: args.message,
    documentId: args.documentId,
  });

  const { resolvedContent, userMsg } = await addResolvedSessionUserMessage({
    conversationId: conversation.publicId,
    actorId: actor?.publicId ?? null,
    message: args.message,
    documentId: args.documentId,
    authUser: args.authUser,
    idempotencyKey: args.idempotencyKey,
  });

  const savedContent = userMsg.content ?? resolvedContent.content;
  const savedDocumentId = userMsg.documentId ?? resolvedContent.documentId;

  if ((userMsg as { idempotent?: boolean }).idempotent) {
    return {
      role: 'user' as const,
      content: savedContent,
      documentId: savedDocumentId,
      idempotent: true as const,
    };
  }

  await session.update({ lastActivityAt: new Date() });

  return triggerOrScheduleGeneration({
    session,
    agentId: args.agentId,
    sessionId: args.sessionId,
    savedContent,
    savedDocumentId,
    toolContext: args.toolContext,
    generateFn: generateSessionResponse,
  });
};

export const sendSessionMessage = async (args: {
  agentId: number;
  sessionId: string;
  message: string;
  model?: string;
  toolContext?: Record<string, string>;
  authUser?: AuthUser;
}) => {
  await addSessionMessage({
    agentId: args.agentId,
    sessionId: args.sessionId,
    message: args.message,
    toolContext: args.toolContext,
    authUser: args.authUser,
  });

  return generateSessionResponse({
    agentId: args.agentId,
    sessionId: args.sessionId,
    model: args.model,
    toolContext: args.toolContext,
  });
};

const fetchSessionAndConversation = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  const session = await findSessionRecord({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  if (!session) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  const conversation = session.conversation as InstanceType<
    (typeof db)['Conversation']
  >;
  const agent = (
    session as unknown as {
      agent?: InstanceType<(typeof db)['Agent']>;
    }
  ).agent;

  if (!agent) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  return { session, conversation, agent };
};

export const submitSessionToolOutputs = async (args: {
  agentId: number;
  agentPublicId: string;
  sessionId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
}) => {
  const sessionData = await fetchSessionAndConversation({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  if (!sessionData) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  const result = await submitToolOutputs({
    agentId: args.agentPublicId,
    generationId: args.generationId,
    toolOutputs: args.toolOutputs,
  });

  return processToolOutputResult({
    result,
    conversation: sessionData.conversation,
    agentPublicId: args.agentPublicId,
  });
};

export { getSessionTags, updateSessionTags } from './sessionTags';
