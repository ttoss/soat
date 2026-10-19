import { db } from '../db';
import { DomainError } from '../errors';
import type { ServerToolContextIdentity } from './toolContext';

export type EndUserAttribution = {
  actorId: number | null;
  sessionId: number | null;
};

/**
 * Who a generation runs for, as its entry point names it: a session, whose
 * actor is the end user, or an actor alone where no session exists (an ingest
 * made on an end user's behalf). Public ids.
 */
export type GenerationEndUser = {
  sessionId?: string | null;
  actorId?: string | null;
};

type ResolvedEndUser = {
  actor: { id: number; publicId: string; externalId: string | null } | null;
  session: { id: number } | null;
};

const NO_END_USER: ResolvedEndUser = { actor: null, session: null };

/**
 * The one answer to who a generation runs for, read by its record, its actor
 * quotas, its rollout split and its pinned tool identity alike.
 *
 * A named session wins and supplies the actor, so "actor A billed under actor
 * B's session" stays unrepresentable; an actor stands alone only with no
 * session. Scoped to `projectId` when given. Unresolvable ids yield nulls
 * rather than throwing: entry points validate up front, and losing a
 * dimension later must not block the work being metered.
 */
export const resolveGenerationEndUser = async (
  args: GenerationEndUser & { projectId?: number }
): Promise<ResolvedEndUser> => {
  const scope =
    args.projectId === undefined ? {} : { projectId: args.projectId };
  if (args.sessionId) {
    const session = await db.Session.findOne({
      where: { publicId: args.sessionId, ...scope },
      include: [{ model: db.Actor, as: 'actor' }],
    });
    if (!session) return NO_END_USER;
    const actor = session.actor ?? null;
    return {
      session: { id: session.id as number },
      actor: actor
        ? {
            id: actor.id as number,
            publicId: actor.publicId,
            externalId: actor.externalId ?? null,
          }
        : null,
    };
  }
  if (!args.actorId) return NO_END_USER;
  const actor = await db.Actor.findOne({
    where: { publicId: args.actorId, ...scope },
  });
  return {
    session: null,
    actor: actor
      ? {
          id: actor.id as number,
          publicId: actor.publicId,
          externalId: actor.externalId ?? null,
        }
      : null,
  };
};

/**
 * Validates the end user a caller names on an entry point that accepts one:
 * each id must exist in `projectId`, and an actor beside a session must be that
 * session's own.
 */
export const assertCallerEndUser = async (
  args: GenerationEndUser & { projectId: number }
): Promise<void> => {
  const session = args.sessionId
    ? await db.Session.findOne({
        where: { publicId: args.sessionId, projectId: args.projectId },
        include: [{ model: db.Actor, as: 'actor' }],
      })
    : null;
  if (args.sessionId && !session) {
    throw new DomainError(
      'SESSION_NOT_FOUND',
      `Session '${args.sessionId}' not found.`
    );
  }
  if (!args.actorId) return;
  const actor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: args.projectId },
  });
  if (!actor) {
    throw new DomainError(
      'ACTOR_NOT_FOUND',
      `Actor '${args.actorId}' not found.`
    );
  }
  if (session && session.actorId !== actor.id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Actor '${args.actorId}' is not the actor of session '${args.sessionId}'.`,
      { actor_id: args.actorId, session_id: args.sessionId }
    );
  }
};

/**
 * The end-user attribution a generation's usage event carries, scoped to the
 * generation's project so attribution can never point across tenants.
 */
export const resolveEndUserAttribution = async (
  args: GenerationEndUser & { projectId: number }
): Promise<EndUserAttribution> => {
  const resolved = await resolveGenerationEndUser(args);
  return {
    actorId: resolved.actor?.id ?? null,
    sessionId: resolved.session?.id ?? null,
  };
};

/**
 * Resolves the trusted identity `pinServerIdentityToolContext` stamps into a
 * generation's `tool_context`. `sessionId` is a typed argument set only
 * by server code, never read from a caller bag, so it is stamped even when the
 * session row has already been deleted mid-flight; the actor keys come from the
 * session's actor link, or from the actor named alone.
 */
export const resolveServerToolContextIdentity = async (
  args: GenerationEndUser
): Promise<ServerToolContextIdentity | null> => {
  if (!args.sessionId && !args.actorId) return null;
  const { actor } = await resolveGenerationEndUser(args);
  if (!args.sessionId && !actor) return null;
  return {
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    actorId: actor?.publicId,
    actorExternalId: actor?.externalId ?? undefined,
  };
};

export type GenerationAttribution = {
  // Usage attribution, stored as typed columns. Server-supplied on every path
  // that has them; a caller cannot reach these.
  actionId?: string | null;
  triggerId?: string | null;
  orchestrationRunId?: string | null;
  nodeId?: string | null;
  // The node's retry attempt, so a retried node's generations are told apart
  // rather than inferred from creation order. Set only by the orchestration
  // agent-node path; null everywhere else.
  nodeAttempt?: number | null;
  agentVersion?: number | null;
  // The workload behind the generation when it is not production traffic
  // (`eval`). Read back at metering time onto the usage event's own `source`
  // column (the evaluations module doc).
  source?: string | null;
};

// Normalizes the optional attribution args to their column values, so the
// create call below states each column once.
export const attributionColumns = (args: GenerationAttribution) => {
  return {
    actionId: args.actionId ?? null,
    triggerId: args.triggerId ?? null,
    orchestrationRunId: args.orchestrationRunId ?? null,
    nodeId: args.nodeId ?? null,
    nodeAttempt: args.nodeAttempt ?? null,
    agentVersion: args.agentVersion ?? null,
    source: args.source ?? null,
  };
};

/**
 * The conversation a turn answers: its public id, and the `position` of the
 * last message the turn read, which is where its reply is stored after.
 */
export type GenerationConversation = { id: string; snapshotPosition: number };

/**
 * The conversation columns of a turn's record. The conversation is resolved by
 * public id rather than threaded as an internal id: every other caller of
 * `createGenerationRecord` speaks in public ids, and a conversation that no
 * longer exists simply leaves the column null.
 */
export const conversationColumns = async (
  conversation?: GenerationConversation
): Promise<{
  conversationId: number | null;
  conversationSnapshotPosition: number | null;
}> => {
  const row = conversation
    ? await db.Conversation.findOne({
        where: { publicId: conversation.id },
        attributes: ['id'],
      })
    : null;
  return {
    conversationId: (row?.id as number | undefined) ?? null,
    conversationSnapshotPosition: conversation?.snapshotPosition ?? null,
  };
};

export const findInitiatorGeneration = async (args: {
  initiatorGenerationId?: string | null;
  projectId: number;
}): Promise<InstanceType<(typeof db)['Generation']> | null> => {
  if (!args.initiatorGenerationId) {
    return null;
  }

  const initiatorGeneration = await db.Generation.findOne({
    where: {
      publicId: args.initiatorGenerationId,
      projectId: args.projectId,
    },
  });

  if (!initiatorGeneration) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${args.initiatorGenerationId}' not found.`
    );
  }

  return initiatorGeneration;
};
