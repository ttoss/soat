import { generations } from './generations';
import { listGenerationMemoryAssertions } from './memoryAssertions';

/**
 * Every memory write a turn made, oldest first: each memory rule's firings and
 * the agent's own `write_memory` calls alike. The rows behind the generation's
 * per-rule `extraction` counts.
 */
export const getGenerationMemoryAssertions = async (args: {
  publicId: string;
  projectIds?: number[];
  limit?: number;
  cursor?: string;
}) => {
  const gen = await generations.findByPublicId({
    id: args.publicId,
    projectIds: args.projectIds,
  });
  if (!gen) return null;
  return listGenerationMemoryAssertions({
    generationDbId: gen.id as number,
    limit: args.limit,
    cursor: args.cursor,
  });
};
