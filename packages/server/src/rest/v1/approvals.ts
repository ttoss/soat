import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  approveApproval,
  getApproval,
  listApprovals,
  rejectApproval,
} from 'src/lib/approvals';

const approvalsRouter = new Router<Context>();

approvalsRouter.get('/approvals', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'approvals:ListApprovals',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const expiresBeforeRaw = ctx.query.expiresBefore as string | undefined;

  ctx.body = await listApprovals({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    origin: ctx.query.origin as string | undefined,
    expiresBefore: expiresBeforeRaw ? new Date(expiresBeforeRaw) : undefined,
  });
});

approvalsRouter.get('/approvals/:approval_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const approval = await getApproval({ id: ctx.params.approval_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: approval.projectId!,
    action: 'approvals:GetApproval',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = approval;
});

approvalsRouter.post(
  '/approvals/:approval_id/approve',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const approval = await getApproval({ id: ctx.params.approval_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: approval.projectId!,
      action: 'approvals:ResolveApproval',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = (ctx.request.body ?? {}) as { arguments?: object };

    const { item } = await approveApproval({
      id: ctx.params.approval_id,
      editedArguments: body.arguments ?? null,
      resolvedByUserId: ctx.authUser.id,
    });

    ctx.body = item;
  }
);

approvalsRouter.post('/approvals/:approval_id/reject', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const approval = await getApproval({ id: ctx.params.approval_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: approval.projectId!,
    action: 'approvals:ResolveApproval',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
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
