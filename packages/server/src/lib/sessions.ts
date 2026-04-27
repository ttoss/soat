import { db } from '../db';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { createSessionTransaction } from './sessionTransaction';

const sessionIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Conversation, as: 'conversation' },
    { model: db.Actor, as: 'agentActor' },
    { model: db.Actor, as: 'userActor' },
  ];
};

const extractSessionIds = (session: Parameters<typeof mapSession>[0]) => {
  return {
    agentId: session.agent?.publicId ?? null,
    conversationId: session.conversation?.publicId ?? null,
    actorId: session.userActor?.publicId ?? null,
  };
};

const extractSessionFlags = (session: Parameters<typeof mapSession>[0]) => {
  return {
    autoGenerate: session.autoGenerate ?? false,
  };
};

const extractSessionOptional = (session: Parameters<typeof mapSession>[0]) => {
  return {
    tags: session.tags ?? undefined,
    toolContext: session.toolContext ?? null,
    generatingAt: session.generatingAt ?? null,
  };
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
    ...extractSessionIds(session),
    status: session.status,
    name: session.name ?? null,
    ...extractSessionFlags(session),
    ...extractSessionOptional(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

export const createSession = async (args: {
  projectId: number;
  agentId: number;
  name?: string | null;
  actorId?: string | null;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
}) => {
  const agent = await db.Agent.findByPk(args.agentId);
  if (!agent) {
    return 'agent_not_found' as const;
  }

  // If actorId provided, verify the actor exists in the project
  let existingUserActorId: number | null = null;
  if (args.actorId) {
    const existingUserActor = await db.Actor.findOne({
      where: { publicId: args.actorId, projectId: args.projectId },
    });
    if (!existingUserActor) {
      return 'actor_not_found' as const;
    }
    existingUserActorId = existingUserActor.id;
  }

  const session = await db.sequelize.transaction((t) => {
    return createSessionTransaction({
      projectId: args.projectId,
      agentId: agent.id,
      agentName: agent.name,
      name: args.name,
      existingUserActorId,
      autoGenerate: args.autoGenerate,
      toolContext: args.toolContext,
      transaction: t,
    });
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

export const updateSession = async (args: {
  agentId: number;
  sessionId: string;
  name?: string | null;
  status?: string;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
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

  if (args.autoGenerate !== undefined) {
    session.autoGenerate = args.autoGenerate;
  }

  if (args.toolContext !== undefined) {
    session.toolContext = args.toolContext;
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

export {
  addSessionMessage,
  generateSessionResponse,
  getSessionTags,
  listSessionMessages,
  sendSessionMessage,
  submitSessionToolOutputs,
  updateSessionTags,
} from './sessionOperations';
