import { db } from '../db';
import { DomainError } from '../errors';
import { assertEnumField } from './enumField';
import { emitResourceEvent } from './eventBus';
import { emptyPage, paginatedList } from './pagination';
import { registerResourceFieldMap } from './policyCompiler';
import { sessionIncludes, sessions } from './sessionAccessor';
import { cancelDelayTimer } from './sessionDelayHelpers';
import { emitSessionEvent, readSessionRecord } from './sessionEvents';
import { mapSession } from './sessionMapper';
import { abortSessionGeneration } from './sessionOperations';
import { createSessionTransaction } from './sessionTransaction';
import { applyTagFilter } from './tags';
import {
  acceptStoredToolContext,
  acceptStoredToolContextUpdate,
} from './toolContextCarrier';

export const SESSION_STATUSES = ['open', 'closed', 'expired'] as const;

type SessionStatus = (typeof SESSION_STATUSES)[number];

registerResourceFieldMap({
  resourceType: 'session',
  publicIdColumn: { column: 'publicId' },
  tagsColumn: { column: 'tags' },
});

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
    // An expired session can never dispatch another tool call, so keeping
    // the bag would only park a credential at rest.
    await session.update({ status: 'expired', toolContext: null });
  }
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
  tags?: Record<string, string>;
  actorId?: string | null;
  autoGenerate?: boolean;
  toolContext?: Record<string, string> | null;
  inactivityTtlSeconds?: number;
  messageDelaySeconds?: number | null;
  maxContextMessages?: number | null;
}) => {
  const toolContext = await acceptStoredToolContext({
    toolContext: args.toolContext,
    secretRefs: 'verbatim',
  });

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
      tags: args.tags,
      existingActorId,
      autoGenerate: args.autoGenerate,
      toolContext,
      inactivityTtlSeconds: args.inactivityTtlSeconds,
      messageDelaySeconds: args.messageDelaySeconds,
      maxContextMessages: args.maxContextMessages,
      transaction: t,
    });
  });

  const mapped = mapSession(await sessions.reload(session));

  void emitSessionEvent({ type: 'sessions.created', session });

  return mapped;
};

// Resolves the agent/actor/status filters into `where`, mutating it. Returns
// false when a referenced agent/actor does not exist (caller yields an empty
// page), true otherwise.
const resolveSessionListFilters = async (args: {
  where: Record<string, unknown>;
  agentId?: string;
  actorId?: string;
  statuses?: readonly SessionStatus[];
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

  if (args.statuses?.length) {
    args.where.status = args.statuses;
  }

  return true;
};

export const listSessions = async (args: {
  projectIds?: number[];
  agentId?: string;
  actorId?: string;
  statuses?: readonly SessionStatus[];
  tags?: Record<string, string>;
  policyWhere?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}) => {
  if (args.projectIds !== undefined && args.projectIds.length === 0) {
    return emptyPage(args);
  }

  const where: Record<string, unknown> = {};

  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }
  applyTagFilter({ where, tags: args.tags });

  if (args.policyWhere) {
    Object.assign(where, args.policyWhere);
  }

  const resolved = await resolveSessionListFilters({
    where,
    agentId: args.agentId,
    actorId: args.actorId,
    statuses: args.statuses,
  });
  if (!resolved) {
    return emptyPage(args);
  }

  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      agentId: args.agentId,
      actorId: args.actorId,
      statuses: args.statuses,
      tags: args.tags,
    },
    where,
    order: [['createdAt', 'DESC']],
    query: async ({ where: pageWhere, limit, order }) => {
      const rows = await db.Session.findAll({
        where: pageWhere,
        include: sessionIncludes(),
        order,
        limit,
      });
      // Expiry is applied to the rows this page returns before they are mapped,
      // so a session that timed out is reported as expired rather than active.
      await Promise.all(rows.map(checkAndExpireSession));
      return rows;
    },
    map: mapSession,
  });
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
  projectPublicId: string;
  tags: Record<string, string> | null;
} | null> => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId },
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Project, as: 'project' },
    ],
  });
  if (!session) {
    return null;
  }
  const row = session as InstanceType<(typeof db)['Session']> & {
    agent?: InstanceType<(typeof db)['Agent']> | null;
    project?: InstanceType<(typeof db)['Project']>;
  };
  return {
    agentId: session.agentId as number,
    agentPublicId: row.agent?.publicId as string,
    projectId: session.projectId as number,
    projectPublicId: row.project?.publicId as string,
    tags: session.tags,
  };
};

export const getSession = async (args: {
  agentId: number;
  sessionId: string;
  // Off unless asked for: the formation drift check reads sessions through this
  // function and discards the figure, and the roll-up is two aggregates.
  includeUsage?: boolean;
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

  if (!args.includeUsage) return mapSession(session);

  return readSessionRecord(session);
};

/** The plain optional-field assignments {@link updateSession} applies verbatim. */
const applySessionFieldUpdates = (args: {
  session: InstanceType<(typeof db)['Session']>;
  name?: string | null;
  status?: string;
  autoGenerate?: boolean;
  inactivityTtlSeconds?: number;
  messageDelaySeconds?: number | null;
  maxContextMessages?: number | null;
}): void => {
  const { session } = args;
  if (args.name !== undefined) session.name = args.name;
  if (args.status !== undefined) session.status = args.status;
  if (args.autoGenerate !== undefined) session.autoGenerate = args.autoGenerate;
  if (args.inactivityTtlSeconds !== undefined) {
    session.inactivityTtlSeconds = args.inactivityTtlSeconds;
  }
  if (args.messageDelaySeconds !== undefined) {
    session.messageDelaySeconds = args.messageDelaySeconds;
  }
  if (args.maxContextMessages !== undefined) {
    session.maxContextMessages = args.maxContextMessages;
  }
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
  maxContextMessages?: number | null;
}) => {
  assertEnumField({
    field: 'status',
    value: args.status,
    allowed: SESSION_STATUSES,
  });

  const toolContext = await acceptStoredToolContextUpdate({
    toolContext: args.toolContext,
    secretRefs: 'verbatim',
  });

  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Session '${args.sessionId}' not found.`
    );
  }

  const closesSession = args.status === 'closed' || args.status === 'expired';

  applySessionFieldUpdates({ session, ...args });

  if (toolContext !== undefined) {
    session.toolContext = toolContext;
  }

  // A closed or expired session can never dispatch another tool call, so
  // keeping the bag would only park a credential at rest; last writer wins
  // over whatever this same request just set above.
  if (closesSession) {
    session.toolContext = null;
  }

  await session.save();

  // When a session is closed, cancel any pending delay timers and abort any
  // in-flight LLM call for this session. This prevents a closed session from
  // replaying its message history and re-executing tool calls via a stale timer.
  if (closesSession) {
    const sessionKey = `${args.agentId}#${args.sessionId}`;
    cancelDelayTimer(sessionKey);
    abortSessionGeneration(sessionKey);
  }

  const mapped = mapSession(await sessions.reload(session));

  void emitSessionEvent({ type: 'sessions.updated', session });

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

  // Read before the delete: the event carries the session as it stood.
  const record = await readSessionRecord(await sessions.reload(session));

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

  emitResourceEvent({
    type: 'sessions.deleted',
    projectId: session.projectId,
    resourceType: 'session',
    resourceId: session.publicId,
    data: record,
  });
};

export {
  addSessionMessage,
  generateSessionResponse,
  getSessionTags,
  sendSessionMessage,
  submitSessionToolOutputs,
  updateSessionTags,
} from './sessionOperations';
