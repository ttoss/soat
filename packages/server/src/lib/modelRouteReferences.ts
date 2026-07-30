import { db } from '../db';

/**
 * Model routes in `projectId` whose ordered targets name `aiProviderPublicId`.
 *
 * A target references its provider by public id inside the route's JSONB
 * `targets` array, so there is no foreign key to enforce the reference —
 * deleting the provider would leave a route that fails at build time. The
 * provider-delete guard uses this to treat a route as a live reference, the
 * mirror of the route-delete guard for agents.
 *
 * Filtered in JS rather than with a JSONB predicate: a project holds a handful
 * of routes, and reading the array back keeps the query portable and the target
 * shape in one place.
 */
export const findModelRoutesReferencingProvider = async (args: {
  projectId: number;
  aiProviderPublicId: string;
}): Promise<Array<{ publicId: string }>> => {
  const routes = await db.ModelRoute.findAll({
    where: { projectId: args.projectId },
    attributes: ['publicId', 'targets'],
  });

  return routes
    .filter((route) => {
      const targets = route.targets as Array<{ ai_provider_id?: unknown }>;
      return targets.some((target) => {
        return target.ai_provider_id === args.aiProviderPublicId;
      });
    })
    .map((route) => {
      return { publicId: route.publicId };
    });
};
