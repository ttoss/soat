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

/**
 * The first of `projectIds` by public id in code-unit order, compared here
 * rather than in SQL so the database collation cannot reorder mixed case.
 */
export const firstProjectByPublicId = async (args: {
  projectIds: number[];
}): Promise<number | null> => {
  log('firstProjectByPublicId: candidates=%d', args.projectIds.length);
  const projects = await db.Project.findAll({
    where: { id: args.projectIds },
    attributes: ['id', 'publicId'],
  });
  const first = projects.reduce<(typeof projects)[number] | null>(
    (best, project) => {
      return best === null || project.publicId < best.publicId ? project : best;
    },
    null
  );
  return (first?.id as number | undefined) ?? null;
};
