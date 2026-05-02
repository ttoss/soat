import { db } from '../db';
import { type GenerationResult, submitToolOutputs } from './agents';
import { generateConversationMessage } from './conversationGeneration';
import { addConversationMessage } from './conversationMessages';
import { listConversationMessages } from './conversations';
import { emitEvent, resolveProjectPublicId } from './eventBus';

const GENERATING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

const buildToolContext = (session: InstanceType<(typeof db)['Session']>) => {
  const actor = (
    session as unknown as {
      actor?: InstanceType<(typeof db)['Actor']> | null;
    }
  ).actor;

  return {
    actorId: actor?.publicId ?? '',
    actorExternalId: actor?.externalId ?? '',
    sessionId: session.publicId,
  };
};

const emitGenerationStarted = (
  session: InstanceType<(typeof db)['Session']>
) => {
  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.generation.started',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: { sessionId: session.publicId },
        timestamp: new Date().toISOString(),
      });
    }
  );
};

const emitGenerationRequiresAction = (
  session: InstanceType<(typeof db)['Session']>,
  generationId: string,
  traceId: string
) => {
  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.generation.requires_action',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: {
          sessionId: session.publicId,
          generationId,
          traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );
};

const emitGenerationCompleted = (
  session: InstanceType<(typeof db)['Session']>,
  generationId: string,
  traceId: string
) => {
  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.generation.completed',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: {
          sessionId: session.publicId,
          generationId,
          traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );
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
    return 'session_not_found' as const;
  }

  // Concurrency guard: prevent concurrent LLM calls on the same session
  if (session.generatingAt) {
    const elapsed = Date.now() - new Date(session.generatingAt).getTime();
    if (elapsed < GENERATING_TIMEOUT_MS) {
      return 'already_generating' as const;
    }
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
    return 'session_not_found' as const;
  }

  const autoPopulated = buildToolContext(session);
  const mergedToolContext = {
    ...autoPopulated,
    ...(session.toolContext ?? {}),
    ...(args.toolContext ?? {}),
  };

  await session.update({ generatingAt: new Date() });

  emitGenerationStarted(session);

  let result: Awaited<ReturnType<typeof generateConversationMessage>>;

  try {
    result = await generateConversationMessage({
      conversationId: conversation.publicId,
      agentId: agent.publicId,
      model: args.model,
      toolContext: mergedToolContext,
    });
  } finally {
    await session.update({ generatingAt: null });
  }

  if (typeof result === 'string') {
    return result;
  }

  if (result.status === 'requires_action') {
    emitGenerationRequiresAction(session, result.generationId, result.traceId);

    return {
      status: 'requires_action' as const,
      generationId: result.generationId,
      traceId: result.traceId,
      requiredAction: result.requiredAction,
    };
  }

  emitGenerationCompleted(session, result.generationId, result.traceId);

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
    return null;
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
  message: string;
  toolContext?: Record<string, string>;
}) => {
  const session = await findSessionRecord({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  if (!session) {
    return 'session_not_found' as const;
  }

  const conversation = session.conversation as InstanceType<
    (typeof db)['Conversation']
  >;
  const actor = (
    session as unknown as {
      actor?: InstanceType<(typeof db)['Actor']> | null;
    }
  ).actor;

  const userMsg = await addConversationMessage({
    conversationId: conversation.publicId,
    message: args.message,
    role: 'user',
    actorId: actor?.publicId ?? null,
  });

  if (!userMsg) {
    return 'session_not_found' as const;
  }

  if (session.autoGenerate && !session.generatingAt) {
    return generateSessionResponse({
      agentId: args.agentId,
      sessionId: args.sessionId,
      toolContext: args.toolContext,
    });
  }

  return { role: 'user' as const, content: args.message };
};

export const sendSessionMessage = async (args: {
  agentId: number;
  sessionId: string;
  message: string;
  model?: string;
  toolContext?: Record<string, string>;
}) => {
  const saveResult = await addSessionMessage({
    agentId: args.agentId,
    sessionId: args.sessionId,
    message: args.message,
    toolContext: args.toolContext,
  });

  if (typeof saveResult === 'string') {
    return saveResult;
  }

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
    return null;
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
    return null;
  }

  return { session, conversation, agent };
};

const processToolOutputResult = async (args: {
  result: GenerationResult;
  conversation: InstanceType<(typeof db)['Conversation']>;
  agentPublicId: string;
}) => {
  // Persist the assistant reply as a conversation message
  if (args.result.status === 'completed' && args.result.output?.content) {
    await addConversationMessage({
      conversationId: args.conversation.publicId,
      message: args.result.output.content,
      role: 'assistant',
      agentId: args.agentPublicId,
    });
  }

  if (args.result.status === 'requires_action') {
    return {
      status: 'requires_action' as const,
      generationId: args.result.id,
      traceId: args.result.traceId,
      requiredAction: args.result.requiredAction!,
    };
  }

  return {
    status: 'completed' as const,
    message: {
      role: 'assistant' as const,
      content: args.result.output?.content ?? '',
      model: args.result.output?.model,
    },
    generationId: args.result.id,
    traceId: args.result.traceId,
  };
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
    return 'session_not_found' as const;
  }

  const result = await submitToolOutputs({
    agentId: args.agentPublicId,
    generationId: args.generationId,
    toolOutputs: args.toolOutputs,
  });

  if (result === 'not_found' || result === 'generation_not_found') {
    return result;
  }

  return processToolOutputResult({
    result,
    conversation: sessionData.conversation,
    agentPublicId: args.agentPublicId,
  });
};

export { getSessionTags, updateSessionTags } from './sessionTags';
