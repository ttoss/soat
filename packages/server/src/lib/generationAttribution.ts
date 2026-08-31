import { db } from '../db';
import type { ServerToolContextIdentity } from './toolContext';

export type EndUserAttribution = {
  actorId: number | null;
  sessionId: number | null;
};

/**
 * Resolves the session a generation was dispatched for into the end-user
 * attribution its usage event carries, scoped to the generation's project so
 * attribution can never point across tenants.
 *
 * The actor comes from the session row, never from the caller, which makes
 * "actor A billed under actor B's session" unrepresentable. An unresolvable
 * session yields nulls rather than throwing: attribution is billing metadata,
 * and losing a dimension must not block the work being metered.
 */
export const resolveEndUserAttribution = async (args: {
  projectId: number;
  sessionId?: string | null;
}): Promise<EndUserAttribution> => {
  if (!args.sessionId) {
    return { actorId: null, sessionId: null };
  }

  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, projectId: args.projectId },
  });

  return {
    actorId: session?.actorId ?? null,
    sessionId: (session?.id as number | undefined) ?? null,
  };
};

/**
 * Resolves the trusted identity `pinServerIdentityToolContext` stamps into a
 * generation's `tool_context` (#850). `sessionId` is a typed argument set only
 * by server code (the session and conversation dispatch paths), never read
 * from a caller bag, so it is stamped even when the session row has already
 * been deleted mid-flight; the actor keys come from the session's actor link.
 */
export const resolveServerToolContextIdentity = async (args: {
  sessionId?: string | null;
}): Promise<ServerToolContextIdentity | null> => {
  if (!args.sessionId) return null;

  const session = await db.Session.findOne({
    where: { publicId: args.sessionId },
    include: [{ model: db.Actor, as: 'actor' }],
  });
  const actor = session?.actor ?? null;

  return {
    sessionId: args.sessionId,
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
