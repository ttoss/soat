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
 * The first of `projectIds` (never empty) by public id in code-unit order,
 * compared here rather than in SQL so the collation cannot reorder mixed case.
 */
export const firstProjectByPublicId = async (args: {
  projectIds: number[];
}): Promise<number> => {
  log('firstProjectByPublicId: candidates=%d', args.projectIds.length);
  const projects = await db.Project.findAll({
    where: { id: args.projectIds },
    attributes: ['id', 'publicId'],
  });
  const idByPublicId = new Map(
    projects.map((project) => {
      return [project.publicId, project.id as number];
    })
  );
  const [firstPublicId] = [...idByPublicId.keys()].sort();
  return idByPublicId.get(firstPublicId as string) as number;
};
