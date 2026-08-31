import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import { findOrchestration } from 'src/lib/orchestrations';
import { setAuditResourceHint } from 'src/middleware/audit';

import { requireAuth, requireProjectAccess } from './helpers';

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

// Run-scoped actions address an existing run, so unlike create they need no
// primary project — `projectIds` is only a scoping filter. Requiring a
// resolvable primary id here broke the unrestricted admin JWT, for which
// `resolveProjectIds()` legitimately returns `undefined`.
export const resolveRunAuth = async (
  ctx: Context,
  action: string
): Promise<{ projectIds?: number[] }> => {
  requireAuth(ctx);
  // An empty array means "permitted in zero projects"; `undefined` means
  // unrestricted. Only the former is rejected — deferred to
  // `requireProjectAccess` rather than restated here.
  const projectIds = await requireProjectAccess({
    ctx,
    action,
    resourceType: 'orchestration',
  });

  return { projectIds: projectIds ?? undefined };
};

export const resolveStartRunScope = async (
  ctx: Context
): Promise<{ projectIds?: number[]; primaryId?: number }> => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'orchestrations:StartRun',
    resourceType: 'orchestration',
  });

  // `projectIds` is either `undefined` (unrestricted admin JWT) or non-empty —
  // `requireProjectAccess` has already refused the empty scope.
  const resolvedProjectIds =
    projectIds ??
    (ctx.authUser.apiKeyProjectId ? [ctx.authUser.apiKeyProjectId] : undefined);

  const primaryId = resolvedProjectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  return { projectIds: resolvedProjectIds, primaryId };
};
