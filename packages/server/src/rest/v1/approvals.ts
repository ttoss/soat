import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  approveApproval,
  getApproval,
  listApprovalRecurrences,
  listApprovals,
  rejectApproval,
} from 'src/lib/approvals';
import { buildSrn } from 'src/lib/iam';

import type { ProjectOwned } from './helpers';
import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';

const approvalsRouter = new Router<Context>();

/**
 * Item-level SRN for a single approval. The get/resolve handlers authorize
 * against this concrete resource rather than the implicit `*` default so a
 * project-scoped principal — whose policy grants an SRN pattern such as
 * `soat:<project>:*:*`, never the bare `*` — is granted access. Passing no
 * resource defaults to `*`, which such a policy cannot match, wrongly denying
 * get/approve/reject while `list` (already SRN-checked) succeeds.
 */
const approvalSrn = (approval: { id: string } & ProjectOwned): string => {
  return buildSrn({
    projectPublicId: approval.project_id!,
    resourceType: 'approval',
    resourceId: approval.id,
  });
};

approvalsRouter.get('/approvals', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'approvals:ListApprovals',
    resourceType: 'approval',
  });

  const expiresBeforeRaw = ctx.query.expires_before as string | undefined;

  ctx.body = await listApprovals({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    origin: ctx.query.origin as string | undefined,
    expiresBefore: expiresBeforeRaw ? new Date(expiresBeforeRaw) : undefined,
    ...parsePagination(ctx),
  });
});

// Registered before `/approvals/:approval_id` so the static `recurrences`
// segment matches this handler rather than binding as an `:approval_id` value.
approvalsRouter.get('/approvals/recurrences', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'approvals:ListApprovalRecurrences',
    resourceType: 'approval',
  });

  const minCountRaw = ctx.query.min_count as string | undefined;
  const minCount =
    minCountRaw != null ? Number.parseInt(minCountRaw, 10) : undefined;

  ctx.body = await listApprovalRecurrences({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    minCount: Number.isFinite(minCount) ? minCount : undefined,
    ...parsePagination(ctx),
  });
});

approvalsRouter.get('/approvals/:approval_id', async (ctx: Context) => {
  requireAuth(ctx);

  const approval = await getApproval({ id: ctx.params.approval_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: approval.project_id!,
    action: 'approvals:GetApproval',
    resource: approvalSrn(approval),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = approval;
});

approvalsRouter.post(
  '/approvals/:approval_id/approve',
  async (ctx: Context) => {
    requireAuth(ctx);

    const approval = await getApproval({ id: ctx.params.approval_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: approval.project_id!,
      action: 'approvals:ResolveApproval',
      resource: approvalSrn(approval),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const body = ctx.request.body as { arguments?: object };

    const { item } = await approveApproval({
      id: ctx.params.approval_id,
      editedArguments: body.arguments ?? null,
      resolvedByUserId: ctx.authUser.id,
    });

    ctx.body = item;
  }
);

approvalsRouter.post('/approvals/:approval_id/reject', async (ctx: Context) => {
  requireAuth(ctx);

  const approval = await getApproval({ id: ctx.params.approval_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: approval.project_id!,
    action: 'approvals:ResolveApproval',
    resource: approvalSrn(approval),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  // `reason` is guaranteed present by the strict-field middleware (required in
  // the OpenAPI request schema); the lib re-checks for a non-empty value.
  const body = ctx.request.body as { reason: string };

  const { item } = await rejectApproval({
    id: ctx.params.approval_id,
    reason: body.reason,
    resolvedByUserId: ctx.authUser.id,
  });

  ctx.body = item;
});

export { approvalsRouter };
