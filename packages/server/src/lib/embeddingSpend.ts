import createDebug from 'debug';
import { db } from 'src/db';

const log = createDebug('soat:embeddings');

/**
 * The permission that lets a caller spend a project's embedding budget. Every
 * route that embeds on a caller's behalf checks it on the project it bills, so
 * a read permission never spends another project's budget.
 */
export const EMBEDDING_SPEND = {
  action: 'embeddings:CreateEmbeddings',
  resourceType: 'embedding',
} as const;

/** The first of `projectIds` by public id, so the choice is stable across environments. */
export const firstProjectByPublicId = async (args: {
  projectIds: number[];
}): Promise<number | null> => {
  log('firstProjectByPublicId: candidates=%d', args.projectIds.length);
  if (args.projectIds.length === 0) return null;
  const project = await db.Project.findOne({
    where: { id: args.projectIds },
    attributes: ['id'],
    order: [['publicId', 'ASC']],
  });
  return (project?.id as number | undefined) ?? null;
};
