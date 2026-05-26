import type { Context } from 'src/Context';

export const resolveStartRunScope = async (
  ctx: Context
): Promise<{ projectIds?: number[]; primaryId?: number } | null> => {
  const projectIds = await ctx.authUser!.resolveProjectIds({
    action: 'orchestrations:StartRun',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  if (
    Array.isArray(projectIds) &&
    projectIds.length === 0 &&
    !ctx.authUser!.apiKeyProjectId
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  const resolvedProjectIds =
    projectIds && projectIds.length > 0
      ? projectIds
      : ctx.authUser!.apiKeyProjectId
        ? [ctx.authUser!.apiKeyProjectId]
        : undefined;

  const primaryId = resolvedProjectIds?.[0] ?? ctx.authUser!.apiKeyProjectId;
  return { projectIds: resolvedProjectIds, primaryId };
};
