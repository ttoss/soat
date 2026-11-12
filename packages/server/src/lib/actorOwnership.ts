import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';

/**
 * An item that belongs to one end user: a playbook case, a memory. Its
 * container is project configuration and belongs to no one. The REST half,
 * the `actor_id` pin on every by-id route, is `rest/v1/resourcePins.ts`.
 */

const log = createDebug('soat:actorOwnership');

/** No actor row carries it, so an owner filter naming an unknown actor matches nothing. */
const NO_ACTOR = -1;

/**
 * The actor an item is created for, held to the container's project; null
 * when none is named. Set on create only: no update path takes it.
 */
export const resolveOwnerActorDbId = async (args: {
  actorId: unknown;
  projectId: number | null;
  /** Where the actor must be, for the refusal: "the playbook's project". */
  projectLabel: string;
}): Promise<number | null> => {
  log('resolveOwnerActorDbId: actorId=%o', args.actorId);
  if (args.actorId === undefined || args.actorId === null) return null;
  const actor =
    typeof args.actorId === 'string'
      ? await db.Actor.findOne({
          where: { publicId: args.actorId, projectId: args.projectId },
          attributes: ['id'],
        })
      : null;
  if (!actor) {
    throw new DomainError(
      'ACTOR_NOT_FOUND',
      `Actor '${String(args.actorId)}' not found in ${args.projectLabel}.`
    );
  }
  return actor.id as number;
};

/**
 * The `where` narrowing items to one actor's: `{}` when the call names none,
 * and nothing at all for an actor that does not exist.
 */
export const ownerActorWhere = async (args: {
  actorId: string | undefined;
}): Promise<{ actorId?: number }> => {
  log('ownerActorWhere: actorId=%s', args.actorId);
  if (args.actorId === undefined) return {};
  const actor = await db.Actor.findOne({
    where: { publicId: args.actorId },
    attributes: ['id'],
  });
  return { actorId: (actor?.id as number | undefined) ?? NO_ACTOR };
};
