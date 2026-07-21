import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getAuditEntry, listAuditEntries } from 'src/lib/auditLog';

const auditLogRouter = new Router<Context>();

const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

auditLogRouter.get('/audit-log', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'audit:ListAuditEntries',
    resourceType: 'audit',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAuditEntries({
    projectIds,
    action: ctx.query.action as string | undefined,
    actorId: ctx.query.actorId as string | undefined,
    resourcePublicId: ctx.query.resourcePublicId as string | undefined,
    resourceSrn: ctx.query.resourceSrn as string | undefined,
    from: parseDate(ctx.query.from),
    to: parseDate(ctx.query.to),
    limit: ctx.query.limit ? Number(ctx.query.limit) : undefined,
    offset: ctx.query.offset ? Number(ctx.query.offset) : undefined,
  });
});

auditLogRouter.get('/audit-log/:entry_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'audit:GetAuditEntry',
    resourceType: 'audit',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getAuditEntry({ id: ctx.params.entry_id, projectIds });
});

export { auditLogRouter };
