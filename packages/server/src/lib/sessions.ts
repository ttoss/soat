import { db } from '../db';
import { submitToolOutputs } from './agents';
import {
  addConversationMessage,
  generateConversationMessage,
  listConversationMessages,
} from './conversations';
import { emitEvent, resolveProjectPublicId } from './eventBus';

const sessionIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Conversation, as: 'conversation' },
    { model: db.Actor, as: 'agentActor' },
    { model: db.Actor, as: 'userActor' },
  ];
};

const mapSession = (
  session: InstanceType<(typeof db)['Session']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']>;
    conversation?: InstanceType<(typeof db)['Conversation']>;
    agentActor?: InstanceType<(typeof db)['Actor']>;
    userActor?: InstanceType<(typeof db)['Actor']>;
  }
) => {
  return {
    id: session.publicId,
    agentId: session.agent?.publicId ?? null,
    conversationId: session.conversation?.publicId ?? null,
    status: session.status,
    name: session.name ?? null,
    actorId: session.userActor?.publicId ?? null,
    tags: session.tags ?? undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

export const createSession = async (args: {
  projectId: number;
  agentId: number;
  name?: string | null;
  actorId?: string | null;
}) => {
  const sequelize = db.sequelize;

  const agent = await db.Agent.findByPk(args.agentId);
  if (!agent) {
    return 'agent_not_found' as const;
  }

  // If actorId provided, verify the actor exists in the project
  let existingUserActor: InstanceType<(typeof db)['Actor']> | null = null;
  if (args.actorId) {
    existingUserActor = await db.Actor.findOne({
      where: { publicId: args.actorId, projectId: args.projectId },
    });
    if (!existingUserActor) {
      return 'actor_not_found' as const;
    }
  }

  const session = await sequelize.transaction(async (t) => {
    // 1. Create agent actor
    const agentActor = await db.Actor.create(
      {
        projectId: args.projectId,
        name: agent.name || 'Agent',
        type: 'agent',
        agentId: agent.id,
      },
      { transaction: t }
    );

    // 2. Create or reuse user actor
    const userActor =
      existingUserActor ??
      (await db.Actor.create(
        {
          projectId: args.projectId,
          name: 'User',
          type: 'user',
        },
        { transaction: t }
      ));

    // 3. Create conversation
    const conversation = await db.Conversation.create(
      {
        projectId: args.projectId,
        name: args.name ?? null,
        status: 'open',
      },
      { transaction: t }
    );

    // 4. Create session
    const sess = await db.Session.create(
      {
        projectId: args.projectId,
        agentId: agent.id,
        conversationId: conversation.id,
        agentActorId: agentActor.id,
        userActorId: userActor.id,
        status: 'open',
        name: args.name ?? null,
      },
      { transaction: t }
    );

    return sess;
  });

  const sessionWithIncludes = await db.Session.findOne({
    where: { id: session.id },
    include: sessionIncludes(),
  });

  const mapped = mapSession(sessionWithIncludes!);

  resolveProjectPublicId({ projectId: args.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.created',
        projectId: args.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: mapped.id,
        data: mapped as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
};

export const listSessions = async (args: {
  projectIds?: number[];
  agentId: number;
  actorId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return { data: [], total: 0, limit, offset };
  }

  const where: Record<string, unknown> = {
    agentId: args.agentId,
  };

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  if (args.actorId !== undefined) {
    const actor = await db.Actor.findOne({
      where: { publicId: args.actorId },
    });
    if (!actor) {
      return { data: [], total: 0, limit, offset };
    }
    where.userActorId = actor.id;
  }

  if (args.status !== undefined) {
    where.status = args.status;
  }

  const { count, rows } = await db.Session.findAndCountAll({
    where,
    include: sessionIncludes(),
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });

  return { data: rows.map(mapSession), total: count, limit, offset };
};

export const getSession = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
    include: sessionIncludes(),
  });

  if (!session) {
    return null;
  }

  return mapSession(session);
};

/**
 * Internal helper that returns the raw Session model instance.
 */
const findSessionRecord = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  return db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
    include: sessionIncludes(),
  });
};

export const updateSession = async (args: {
  agentId: number;
  sessionId: string;
  name?: string | null;
  status?: string;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    return null;
  }

  if (args.name !== undefined) {
    session.name = args.name;
  }

  if (args.status !== undefined) {
    session.status = args.status;
  }

  await session.save();

  const sessionWithIncludes = await db.Session.findOne({
    where: { id: session.id },
    include: sessionIncludes(),
  });

  const mapped = mapSession(sessionWithIncludes!);

  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.updated',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: mapped.id,
        data: mapped as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return mapped;
};

export const deleteSession = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    return null;
  }

  const sequelize = db.sequelize;

  await sequelize.transaction(async (t) => {
    // Delete the session record first
    await session.destroy({ transaction: t });
    // Delete underlying conversation (cascades messages)
    await db.Conversation.destroy({
      where: { id: session.conversationId },
      transaction: t,
    });
    // Delete both actors
    await db.Actor.destroy({
      where: { id: [session.agentActorId, session.userActorId] },
      transaction: t,
    });
  });

  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.deleted',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: { id: session.publicId },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return { id: session.publicId };
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

  // Map actor IDs to simple roles
  const agentActorPublicId = (
    session as unknown as {
      agentActor?: InstanceType<(typeof db)['Actor']>;
    }
  ).agentActor?.publicId;
  const userActorPublicId = (
    session as unknown as {
      userActor?: InstanceType<(typeof db)['Actor']>;
    }
  ).userActor?.publicId;

  const mappedData = result?.data.map((msg) => {
    let role: string;
    if (msg.actorId === userActorPublicId) {
      role = 'user';
    } else if (msg.actorId === agentActorPublicId) {
      role = 'assistant';
    } else {
      role = 'unknown';
    }

    return {
      role,
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
  const userActor = (
    session as unknown as {
      userActor?: InstanceType<(typeof db)['Actor']>;
    }
  ).userActor;

  if (!userActor) {
    return 'session_not_found' as const;
  }

  const userMsg = await addConversationMessage({
    conversationId: conversation.publicId,
    message: args.message,
    actorId: userActor.publicId,
  });

  if (!userMsg) {
    return 'session_not_found' as const;
  }

  return { role: 'user' as const, content: args.message };
};

const GENERATING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export const generateSessionResponse = async (args: {
  agentId: number;
  sessionId: string;
  model?: string;
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
  const agentActor = (
    session as unknown as {
      agentActor?: InstanceType<(typeof db)['Actor']>;
    }
  ).agentActor;

  if (!agentActor) {
    return 'session_not_found' as const;
  }

  await session.update({ generatingAt: new Date() });

  let result: Awaited<ReturnType<typeof generateConversationMessage>>;

  try {
    result = await generateConversationMessage({
      conversationId: conversation.publicId,
      actorId: agentActor.publicId,
      model: args.model,
    });
  } finally {
    await session.update({ generatingAt: null });
  }

  if (typeof result === 'string') {
    return result;
  }

  if (result.status === 'requires_action') {
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
            generationId: result.generationId,
            traceId: result.traceId,
          },
          timestamp: new Date().toISOString(),
        });
      }
    );

    return {
      status: 'requires_action' as const,
      generationId: result.generationId,
      traceId: result.traceId,
      requiredAction: result.requiredAction,
    };
  }

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
          generationId: result.generationId,
          traceId: result.traceId,
        },
        timestamp: new Date().toISOString(),
      });
    }
  );

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

export const sendSessionMessage = async (args: {
  agentId: number;
  sessionId: string;
  message: string;
  model?: string;
}) => {
  const saveResult = await addSessionMessage({
    agentId: args.agentId,
    sessionId: args.sessionId,
    message: args.message,
  });

  if (typeof saveResult === 'string') {
    return saveResult;
  }

  return generateSessionResponse({
    agentId: args.agentId,
    sessionId: args.sessionId,
    model: args.model,
  });
};

export const submitSessionToolOutputs = async (args: {
  agentId: number;
  agentPublicId: string;
  sessionId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
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
  const agentActor = (
    session as unknown as {
      agentActor?: InstanceType<(typeof db)['Actor']>;
    }
  ).agentActor;

  if (!agentActor) {
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

  // Persist the assistant reply as a conversation message
  if (result.status === 'completed' && result.output?.content) {
    await addConversationMessage({
      conversationId: conversation.publicId,
      message: result.output.content,
      actorId: agentActor.publicId,
    });
  }

  if (result.status === 'requires_action') {
    return {
      status: 'requires_action' as const,
      generationId: result.id,
      traceId: result.traceId,
      requiredAction: result.requiredAction!,
    };
  }

  return {
    status: 'completed' as const,
    message: {
      role: 'assistant' as const,
      content: result.output?.content ?? '',
      model: result.output?.model,
    },
    generationId: result.id,
    traceId: result.traceId,
  };
};

export const getSessionTags = async (args: {
  agentId: number;
  sessionId: string;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    return null;
  }

  return session.tags ?? {};
};

export const updateSessionTags = async (args: {
  agentId: number;
  sessionId: string;
  tags: Record<string, string>;
  merge?: boolean;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    return null;
  }

  if (args.merge) {
    session.tags = { ...(session.tags ?? {}), ...args.tags };
  } else {
    session.tags = args.tags;
  }

  await session.save();

  resolveProjectPublicId({ projectId: session.projectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'sessions.tags.updated',
        projectId: session.projectId,
        projectPublicId,
        resourceType: 'session',
        resourceId: session.publicId,
        data: { tags: session.tags },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return session.tags;
};
