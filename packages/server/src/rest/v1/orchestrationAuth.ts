import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { findOrchestration } from 'src/lib/orchestrations';
import { setAuditResourceHint } from 'src/middleware/audit';

import { requireAuth, resolveReadProjectIds } from './helpers';

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
    projectPublicId: orchestration.project_id,
    resourceSrn: buildSrn({
      projectPublicId: orchestration.project_id,
      resourceType: 'orchestration',
      resourceId: orchestration.id,
    }),
    resourcePublicId: orchestration.id,
  });
};

// Run-scoped actions (cancel/human-input/resume) address an existing run by
// orchestration_run_id, so unlike create they never need a single "primary" project to
// create into — projectIds is only used as an optional scoping filter, same
// as GET /orchestration-runs/:orchestration_run_id. Requiring a resolvable primaryId here
// broke the unrestricted admin JWT case, where resolveProjectIds()
// legitimately returns `undefined` ("no filter — all projects").
export const resolveRunAuth = async (
  ctx: Context,
  action: string
): Promise<{ projectIds?: number[] }> => {
  requireAuth(ctx);
  const projectIds = await resolveReadProjectIds({
    ctx,
    action,
    resourceType: 'orchestration',
  });

  // An empty (but non-null) array means "permitted in zero projects" for a
  // scoped user — distinct from `undefined`, which means "unrestricted" for
  // an admin JWT. Only the former should be rejected.
  if (
    Array.isArray(projectIds) &&
    projectIds.length === 0 &&
    !ctx.authUser.apiKeyProjectId
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return { projectIds: projectIds ?? undefined };
};

export const resolveStartRunScope = async (
  ctx: Context
): Promise<{ projectIds?: number[]; primaryId?: number }> => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'orchestrations:StartRun',
    resourceType: 'orchestration',
  });

  if (
    Array.isArray(projectIds) &&
    projectIds.length === 0 &&
    !ctx.authUser.apiKeyProjectId
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const resolvedProjectIds =
    projectIds && projectIds.length > 0
      ? projectIds
      : ctx.authUser.apiKeyProjectId
        ? [ctx.authUser.apiKeyProjectId]
        : undefined;

  const primaryId = resolvedProjectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  return { projectIds: resolvedProjectIds, primaryId };
};
