import { db } from '../db';
import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { cancelDelayTimer } from './sessionDelayHelpers';
import { abortSessionGeneration } from './sessionOperations';
import { createSessionTransaction } from './sessionTransaction';

const isSessionExpired = (session: InstanceType<(typeof db)['Session']>) => {
  const ttl = session.inactivityTtlSeconds;
  if (!ttl || session.status !== 'open') {
    return false;
  }
  const lastActivity = session.lastActivityAt ?? session.createdAt;
  return Date.now() - new Date(lastActivity).getTime() > ttl * 1000;
};

const checkAndExpireSession = async (
  session: InstanceType<(typeof db)['Session']>
) => {
  if (isSessionExpired(session)) {
    await session.update({ status: 'expired' });
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

const extractSessionIds = (session: Parameters<typeof mapSession>[0]) => {
  return {
    agentId: session.agent?.publicId ?? null,
    conversationId: session.conversation?.publicId ?? null,
    actorId: session.actor?.publicId ?? null,
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
    inactivityTtlSeconds: session.inactivityTtlSeconds ?? 0,
    lastActivityAt: session.lastActivityAt ?? null,
    messageDelaySeconds: session.messageDelaySeconds ?? null,
  };
};

const mapSession = (
  session: InstanceType<(typeof db)['Session']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']>;
    conversation?: InstanceType<(typeof db)['Conversation']>;
    actor?: InstanceType<(typeof db)['Actor']> | null;
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

const resolveActorId = async (args: { actorId: string; projectId: number }) => {
  const existingActor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: args.projectId },
  });
  if (!existingActor) {
    throw new DomainError(
      'ACTOR_NOT_FOUND',
      `Actor '${args.actorId}' not found.`
    );
  }
  return existingActor.id;
};

const checkSingleSessionConflict = async (args: {
  agentId: number;
  actorId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
}) => {
  // Acquire a transaction-scoped advisory lock keyed on (agentId, actorId) to
  // serialize concurrent createSession calls for the same actor. The lock is
  // released automatically when the transaction commits or rolls back.
  await db.sequelize.query('SELECT pg_advisory_xact_lock(:agentId, :actorId)', {
    replacements: { agentId: args.agentId, actorId: args.actorId },
    transaction: args.transaction,
  });

  const conflictingSession = await db.Session.findOne({
    where: { agentId: args.agentId, actorId: args.actorId, status: 'open' },
    transaction: args.transaction,
  });

  if (!conflictingSession) {
    return;
  }

  await checkAndExpireSession(conflictingSession);

  if (conflictingSession.status === 'open') {
    throw new DomainError(
      'SINGLE_SESSION_CONFLICT',
      'An open session already exists for this actor.',
      { session_id: conflictingSession.publicId }
    );
  }
};

export const createSession = async (args: {
  projectId: number;
  agentId: number;
  name?: string | null;
  actorId?: string | null;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
  inactivityTtlSeconds?: number;
  messageDelaySeconds?: number | null;
}) => {
  const agent = await db.Agent.findByPk(args.agentId);
  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent with id '${args.agentId}' not found.`
    );
  }

  let existingActorId: number | null = null;
  if (args.actorId) {
    existingActorId = await resolveActorId({
      actorId: args.actorId,
      projectId: args.projectId,
    });
  }

  const session = await db.sequelize.transaction(async (t) => {
    if (agent.singleSessionPerActor && existingActorId) {
      await checkSingleSessionConflict({
        agentId: agent.id,
        actorId: existingActorId,
        transaction: t,
      });
    }
    return createSessionTransaction({
      projectId: args.projectId,
      agentId: agent.id,
      name: args.name,
      existingActorId,
      autoGenerate: args.autoGenerate,
      toolContext: args.toolContext,
      inactivityTtlSeconds: args.inactivityTtlSeconds,
      messageDelaySeconds: args.messageDelaySeconds,
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

// Resolves the agent/actor/status filters into `where`, mutating it. Returns
// false when a referenced agent/actor does not exist (caller yields an empty
// page), true otherwise.
const resolveSessionListFilters = async (args: {
  where: Record<string, unknown>;
  agentId?: string;
  actorId?: string;
  status?: string;
}): Promise<boolean> => {
  if (args.agentId !== undefined) {
    const agent = await db.Agent.findOne({
      where: { publicId: args.agentId },
    });
    if (!agent) return false;
    args.where.agentId = agent.id;
  }

  if (args.actorId !== undefined) {
    const actor = await db.Actor.findOne({
      where: { publicId: args.actorId },
    });
    if (!actor) return false;
    args.where.actorId = actor.id;
  }

  if (args.status !== undefined) {
    args.where.status = args.status;
  }

  return true;
};

export const listSessions = async (args: {
  projectIds?: number[];
  agentId?: string;
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

  const where: Record<string, unknown> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const resolved = await resolveSessionListFilters({
    where,
    agentId: args.agentId,
    actorId: args.actorId,
    status: args.status,
  });
  if (!resolved) {
    return { data: [], total: 0, limit, offset };
  }

  const { count, rows } = await db.Session.findAndCountAll({
    where,
    include: sessionIncludes(),
    limit,
    offset,
    order: [['createdAt', 'DESC']],
  });

  await Promise.all(rows.map(checkAndExpireSession));

  return { data: rows.map(mapSession), total: count, limit, offset };
};

/**
 * Resolve the agent and project a session belongs to, for top-level route
 * access control (the session id alone is globally unique). Returns null when
 * the session does not exist.
 */
export const findSessionAccess = async (args: {
  sessionId: string;
}): Promise<{
  agentId: number;
  agentPublicId: string;
  projectId: number;
} | null> => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId },
    include: [{ model: db.Agent, as: 'agent' }],
  });
  if (!session) {
    return null;
  }
  const agent = (
    session as InstanceType<(typeof db)['Session']> & {
      agent?: InstanceType<(typeof db)['Agent']>;
    }
  ).agent;
  return {
    agentId: session.agentId as number,
    agentPublicId: agent?.publicId as string,
    projectId: session.projectId as number,
  };
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
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Session '${args.sessionId}' not found.`
    );
  }

  await checkAndExpireSession(session);

  return mapSession(session);
};

export const updateSession = async (args: {
  agentId: number;
  sessionId: string;
  name?: string | null;
  status?: string;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
  inactivityTtlSeconds?: number;
  messageDelaySeconds?: number | null;
}) => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Session '${args.sessionId}' not found.`
    );
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

  if (args.inactivityTtlSeconds !== undefined) {
    session.inactivityTtlSeconds = args.inactivityTtlSeconds;
  }

  if (args.messageDelaySeconds !== undefined) {
    session.messageDelaySeconds = args.messageDelaySeconds;
  }

  await session.save();

  // When a session is closed, cancel any pending delay timers and abort any
  // in-flight LLM call for this session. This prevents a closed session from
  // replaying its message history and re-executing tool calls via a stale timer.
  if (args.status === 'closed' || args.status === 'expired') {
    const sessionKey = `${args.agentId}#${args.sessionId}`;
    cancelDelayTimer(sessionKey);
    abortSessionGeneration(sessionKey);
  }

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
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Session '${args.sessionId}' not found.`
    );
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
};

export {
  addSessionMessage,
  generateSessionResponse,
  getSessionTags,
  sendSessionMessage,
  submitSessionToolOutputs,
  updateSessionTags,
} from './sessionOperations';
