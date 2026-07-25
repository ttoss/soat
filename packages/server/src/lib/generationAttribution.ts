import { db } from '../db';

export type EndUserAttribution = {
  actorId: number | null;
  sessionId: number | null;
};

/**
 * Resolves the session a generation was dispatched for into the end-user
 * attribution its usage event carries, scoped to the generation's project so
 * attribution can never point across tenants.
 *
 * The actor is taken from the session row rather than accepted from the
 * caller. The session already owns the actor link, so deriving it here makes
 * "actor A billed under actor B's session" unrepresentable, and callers that
 * only know the session (the client-tool re-handoff path) still get full
 * attribution. A session with no actor attributes the session alone.
 *
 * A session id that does not resolve — a deleted session referenced by an
 * older row — yields nulls rather than throwing: attribution is billing
 * metadata, and losing a dimension must never block the work being metered.
 * The spend is still recorded, just unattributed.
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
