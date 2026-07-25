import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import { findOrchestration } from 'src/lib/orchestrations';
import { setAuditResourceHint } from 'src/middleware/audit';

/**
 * Resolves the target orchestration's project/SRN and hands it to the audit
 * middleware before a `204`-returning mutation runs — the response body it
 * would otherwise backfill from is empty (see `setAuditResourceHint`).
 * No-ops when the orchestration cannot be found under `projectIds`; the
 * subsequent delete call surfaces the same not-found error to the caller.
 */
export const hintAuditResourceForOrchestration = async (args: {
  ctx: Context;
  id: string;
  projectIds?: number[];
}): Promise<void> => {
  const orchestration = await findOrchestration({
    id: args.id,
    projectIds: args.projectIds,
  });
  if (!orchestration) return;
  setAuditResourceHint(args.ctx, {
    projectPublicId: orchestration.projectId,
    resourceSrn: buildSrn({
      projectPublicId: orchestration.projectId,
      resourceType: 'orchestration',
      resourceId: orchestration.id,
    }),
    resourcePublicId: orchestration.id,
  });
};

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
  const projectIds = await ctx.authUser.resolveProjectIds({
    action,
    resourceType: 'orchestration',
  });

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
    resourceType: 'orchestration',
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
