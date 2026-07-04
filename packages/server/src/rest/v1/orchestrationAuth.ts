import type { Context } from 'src/Context';

// Run-scoped actions (cancel/human-input/resume) address an existing run by
// run_id, so unlike create they never need a single "primary" project to
// create into — projectIds is only used as an optional scoping filter, same
// as GET /orchestration-runs/:run_id. Requiring a resolvable primaryId here
// broke the unrestricted admin JWT case, where resolveProjectIds()
// legitimately returns `undefined` ("no filter — all projects").
export const resolveRunAuth = async (
  ctx: Context,
  action: string
): Promise<{ projectIds?: number[] } | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({ action });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  // An empty (but non-null) array means "permitted in zero projects" for a
  // scoped user — distinct from `undefined`, which means "unrestricted" for
  // an admin JWT. Only the former should be rejected.
  if (
    Array.isArray(projectIds) &&
    projectIds.length === 0 &&
    !ctx.authUser.apiKeyProjectId
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }

  return { projectIds: projectIds ?? undefined };
};

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
