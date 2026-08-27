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
