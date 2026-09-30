import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import { setAuditResourceHint } from 'src/middleware/audit';

import { requireAuth, requireProjectAccess } from './helpers';

/**
 * Hands the target orchestration's project/SRN to the audit middleware before
 * a `204`-returning mutation runs — the response body it would otherwise
 * backfill from is empty (see `setAuditResourceHint`).
 */
export const hintAuditResourceForOrchestration = (args: {
  ctx: Context;
  id: string;
  projectPublicId: string;
}): void => {
  setAuditResourceHint(args.ctx, {
    projectPublicId: args.projectPublicId,
    resourceSrn: buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: 'orchestration',
      resourceId: args.id,
    }),
    resourcePublicId: args.id,
  });
};

export const resolveStartRunScope = async (
  ctx: Context
): Promise<{ projectIds?: number[] }> => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'orchestrations:StartRun',
    resourceType: 'orchestration',
  });

  return { projectIds };
};
