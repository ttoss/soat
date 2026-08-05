import { db } from '../db';

/**
 * Reads the internal recovery state of a generation paused on a client tool.
 *
 * This lives apart from the generation mappers on purpose. `pendingState` holds
 * the full message history, tool context and agent config needed to resume a
 * `requires_action` generation after a restart, and must never reach an API
 * response — so it has no entry in `mapGeneration` at all, and the one consumer
 * that needs it asks for it here by name. There is no filtering step that a
 * future field could be forgotten from.
 *
 * Returns null when the generation does not exist or is not paused.
 */
export const getGenerationPendingState = async (args: {
  publicId: string;
}): Promise<Record<string, unknown> | null> => {
  const gen = await db.Generation.findOne({
    where: { publicId: args.publicId },
    attributes: ['pendingState'],
  });
  return gen?.pendingState ?? null;
};
