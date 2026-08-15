/**
 * Session forking — branching a new session from a point in another session's
 * history.
 *
 * Two decisions shape everything here:
 *
 * - **Fork by reference, not by copy.** The fork's conversation gets its own
 *   `ConversationMessage` rows — cheap integer ordering — pointing at the
 *   *same* `Document` rows as the parent. The message uniqueness constraints
 *   are conversation-scoped, so this is what the schema already permits. One
 *   stored copy means a retention purge erases the content from parent and
 *   fork together, and a fork cannot silently drift from what actually
 *   happened.
 * - **Replay, never re-invoke.** Nothing here runs a tool or a generation. The
 *   recorded tool-call chain rides along on each message's `responseMessages`,
 *   which is what `conversationGeneration` expands into model input on the next
 *   turn, so a forked turn sees the results the parent's tools returned then —
 *   `send_email` is not sent twice by exploring a "what if".
 */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitResourceEvent } from './eventBus';
import { paginatedList } from './pagination';
import { sessionIncludes, type SessionRow, sessions } from './sessionAccessor';
import { mapSession } from './sessionMapper';
import { assertValidToolContextKeys } from './toolContext';

const log = createDebug('soat:session-fork');

type ParentSession = InstanceType<(typeof db)['Session']>;

const loadParentSession = async (args: {
  agentId: number;
  sessionId: string;
}): Promise<ParentSession> => {
  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, agentId: args.agentId },
  });

  if (!session) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Session '${args.sessionId}' not found.`
    );
  }

  return session;
};

/**
 * The agent the fork runs against: the override when one is given, the parent's
 * otherwise.
 *
 * An override from another project is refused. A fork carries the parent's
 * documents into the new session, so allowing one would move project-owned
 * content across a project boundary — the one thing the project scope exists to
 * prevent.
 *
 * That single comparison is also the whole credential-scope check: the caller
 * already had to reach the parent session, so an agent in the parent's project
 * is by construction one they can reach too. There is no second scope test to
 * keep in sync here.
 */
const resolveForkAgentId = async (args: {
  parent: ParentSession;
  agentPublicId?: string | null;
}): Promise<number> => {
  if (!args.agentPublicId) return args.parent.agentId as number;

  const agent = await db.Agent.findOne({
    where: { publicId: args.agentPublicId },
  });
  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent '${args.agentPublicId}' not found.`
    );
  }
  if (agent.projectId !== args.parent.projectId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Agent '${args.agentPublicId}' belongs to a different project than the session being forked.`
    );
  }

  return agent.id as number;
};

/**
 * The parent messages the fork inherits: everything up to and including
 * `forkAtPosition`, or the whole history when it is omitted.
 *
 * A position that names no message is a `400` rather than a silently shorter
 * fork — a caller branching at a message that is not there has the wrong
 * history in mind, and a fork with the wrong context produces garbage no error
 * would explain.
 */
const loadForkedMessages = async (args: {
  conversationId: number;
  forkAtPosition?: number | null;
}) => {
  const messages = await db.ConversationMessage.findAll({
    where: { conversationId: args.conversationId },
    order: [['position', 'ASC']],
  });

  if (args.forkAtPosition === undefined || args.forkAtPosition === null) {
    return messages;
  }

  const position = args.forkAtPosition;
  if (!Number.isInteger(position) || position < 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'fork_at_position must be a non-negative integer.'
    );
  }

  const branchPoint = messages.find((message) => {
    return message.position === position;
  });
  if (!branchPoint) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `fork_at_position ${position} does not exist in the parent conversation.`
    );
  }

  return messages.filter((message) => {
    return message.position <= position;
  });
};

/**
 * Copies the parent's message ordering into the fork's conversation.
 *
 * `documentId` is carried over verbatim — that reference *is* the feature.
 * `idempotencyKey` is not: the key belongs to the request that wrote the
 * original message, and copying it would make a later, unrelated write in the
 * fork dedupe against a message the caller never sent there.
 */
const copyMessagesIntoFork = async (args: {
  messages: InstanceType<(typeof db)['ConversationMessage']>[];
  conversationId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
}) => {
  if (args.messages.length === 0) return;

  await db.ConversationMessage.bulkCreate(
    args.messages.map((message) => {
      return {
        conversationId: args.conversationId,
        documentId: message.documentId,
        role: message.role,
        actorId: message.actorId ?? null,
        agentId: message.agentId ?? null,
        position: message.position,
        metadata: message.metadata ?? null,
        responseMessages: message.responseMessages ?? null,
        idempotencyKey: null,
      };
    }),
    { transaction: args.transaction }
  );
};

export const forkSession = async (args: {
  agentId: number;
  sessionId: string;
  forkAtPosition?: number | null;
  agentPublicId?: string | null;
  name?: string | null;
  tags?: Record<string, string> | null;
  toolContext?: Record<string, string> | null;
}) => {
  log(
    'forkSession: sessionId=%s forkAtPosition=%s agentPublicId=%s',
    args.sessionId,
    args.forkAtPosition,
    args.agentPublicId
  );

  assertValidToolContextKeys(args.toolContext);

  const parent = await loadParentSession({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  const forkAgentId = await resolveForkAgentId({
    parent,
    agentPublicId: args.agentPublicId,
  });

  const messages = await loadForkedMessages({
    conversationId: parent.conversationId,
    forkAtPosition: args.forkAtPosition,
  });

  // All-or-nothing: a session whose conversation is missing half the branched
  // history is worse than no fork at all, because nothing about it looks wrong.
  const fork = await db.sequelize.transaction(async (t) => {
    const conversation = await db.Conversation.create(
      {
        projectId: parent.projectId,
        name: args.name ?? parent.name ?? null,
        status: 'open',
      },
      { transaction: t }
    );

    const created = await db.Session.create(
      {
        projectId: parent.projectId,
        agentId: forkAgentId,
        conversationId: conversation.id,
        // No actor: `single_session_per_actor` is an invariant over open
        // sessions per (agent, actor), and inheriting the parent's actor would
        // either break it or make forking impossible for exactly the agents
        // that enforce it. Attach one afterwards if the branch is meant to be
        // driven by the same end user.
        actorId: null,
        status: 'open',
        name: args.name ?? null,
        tags: args.tags ?? null,
        // Inert by construction: creating a branch and running it are separate
        // acts, so `POST /fork` never triggers a generation.
        autoGenerate: false,
        toolContext: args.toolContext ?? parent.toolContext ?? null,
        inactivityTtlSeconds: parent.inactivityTtlSeconds ?? 0,
        messageDelaySeconds: parent.messageDelaySeconds ?? null,
        lastActivityAt: null,
        forkedFromSessionId: parent.id,
        forkedFromPosition:
          args.forkAtPosition === undefined ? null : args.forkAtPosition,
      },
      { transaction: t }
    );

    await copyMessagesIntoFork({
      messages,
      conversationId: conversation.id,
      transaction: t,
    });

    return created;
  });

  const mapped = mapSession(await sessions.reload(fork));

  log(
    'forkSession: created session=%s messages=%d',
    mapped.id,
    messages.length
  );

  emitResourceEvent({
    type: 'sessions.created',
    projectId: parent.projectId,
    resourceType: 'session',
    resourceId: mapped.id,
    data: mapped,
  });

  return mapped;
};

/** The sessions forked directly from this one. One level, never a tree. */
export const listSessionForks = async (args: {
  agentId: number;
  sessionId: string;
  limit?: number;
  offset?: number;
}) => {
  const parent = await loadParentSession({
    agentId: args.agentId,
    sessionId: args.sessionId,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Session.findAndCountAll({
        where: { forkedFromSessionId: parent.id },
        include: sessionIncludes(),
        distinct: true,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
      });
    },
    map: (session: SessionRow) => {
      return mapSession(session);
    },
  });
};
