import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:generation');

export type EndUserAttribution = {
  actorId: number | null;
  sessionId: number | null;
};

// Resolves one project-scoped publicId to its internal FK. An id that does not
// resolve logs and yields null rather than throwing — see the note on
// `resolveEndUserAttribution`.
const resolveScoped = async (args: {
  label: string;
  publicId: string | null | undefined;
  projectId: number;
  find: (where: {
    publicId: string;
    projectId: number;
  }) => Promise<{ id?: number } | null>;
}): Promise<number | null> => {
  if (!args.publicId) return null;

  const row = await args.find({
    publicId: args.publicId,
    projectId: args.projectId,
  });
  const id = (row?.id as number | undefined) ?? null;

  if (id === null) {
    log(
      'resolveEndUserAttribution: unresolved %s publicId=%s projectId=%d',
      args.label,
      args.publicId,
      args.projectId
    );
  }
  return id;
};

/**
 * Resolves the end-user attribution public ids (actor / session) a generation
 * was dispatched for into their internal FKs, scoped to the generation's
 * project so attribution can never point across tenants.
 *
 * When a session resolves, **its** actor is authoritative and `actorId` is
 * ignored: the session already owns the actor link, so deriving it here makes
 * "actor A billed under actor B's session" unrepresentable, and callers that
 * only know the session (the client-tool re-handoff path) still get full
 * attribution. `actorId` applies only to work with no session behind it.
 *
 * An id that does not resolve is recorded as `null` rather than throwing:
 * attribution is billing metadata, and losing a dimension must never block the
 * work being metered. The usage event copies these ids at write time, so an
 * unresolved id means the spend is recorded unattributed, never dropped.
 */
export const resolveEndUserAttribution = async (args: {
  projectId: number;
  actorId?: string | null;
  sessionId?: string | null;
}): Promise<EndUserAttribution> => {
  const session = args.sessionId
    ? await db.Session.findOne({
        where: { publicId: args.sessionId, projectId: args.projectId },
      })
    : null;

  if (args.sessionId && !session) {
    log(
      'resolveEndUserAttribution: unresolved session publicId=%s projectId=%d',
      args.sessionId,
      args.projectId
    );
  }

  if (session) {
    return {
      actorId: session.actorId,
      sessionId: session.id as number,
    };
  }

  const actorId = await resolveScoped({
    label: 'actor',
    publicId: args.actorId,
    projectId: args.projectId,
    find: (where) => {
      return db.Actor.findOne({ where });
    },
  });

  return { actorId, sessionId: null };
};
