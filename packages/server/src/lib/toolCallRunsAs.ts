import { db } from '../db';
import { parseWorkAuthority } from './workAuthority';

type Principal = { type: string; id: string };

/**
 * Whom an approved tool call runs as: the end user and authority the proposing
 * generation stores, which resolution reads back (`approvals.md` §Continuation
 * identity). Two calls that differ here are two different actions.
 */
export type ToolCallRunsAs = {
  actorId: string | null;
  principal: Principal | null;
  actsFor: Principal | null;
};

const NO_IDENTITY: ToolCallRunsAs = {
  actorId: null,
  principal: null,
  actsFor: null,
};

/** The identity a call proposed by `generationId` runs as when approved. */
export const toolCallRunsAs = async (
  generationId: string | null | undefined
): Promise<ToolCallRunsAs> => {
  if (!generationId) return NO_IDENTITY;
  const proposing = await db.Generation.findOne({
    where: { publicId: generationId },
    attributes: ['authority', 'startedByActorId'],
    include: [
      { model: db.Actor, as: 'startedByActor', attributes: ['publicId'] },
    ],
  });
  const authority = parseWorkAuthority(proposing?.authority);
  return {
    actorId: proposing?.startedByActor?.publicId ?? null,
    principal: authority?.principal ?? null,
    actsFor: authority?.actsFor ?? null,
  };
};
