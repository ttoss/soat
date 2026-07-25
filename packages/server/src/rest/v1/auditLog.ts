import { Readable } from 'node:stream';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  getAuditEntry,
  listAuditEntries,
  streamAuditEntriesNdjson,
} from 'src/lib/auditLog';

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
    principalId: ctx.query.principalId as string | undefined,
    resourcePublicId: ctx.query.resourcePublicId as string | undefined,
    resourceSrn: ctx.query.resourceSrn as string | undefined,
    from: parseDate(ctx.query.from),
    to: parseDate(ctx.query.to),
    limit: ctx.query.limit ? Number(ctx.query.limit) : undefined,
    offset: ctx.query.offset ? Number(ctx.query.offset) : undefined,
  });
});

// Registered before `/audit-log/:entry_id` so `export` is matched as a literal
// path segment rather than swallowed as an entry id.
auditLogRouter.get('/audit-log/export', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  // Export is deliberately per-project: an unbounded cross-project dump is a
  // different (and much larger) egress surface than this endpoint offers.
  if (!projectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'audit:ExportAuditEntries',
    resourceType: 'audit',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const filename = `audit-log-${projectPublicId}.ndjson`;
  ctx.set('Content-Type', 'application/x-ndjson');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  ctx.status = 200;
  // A stream body is not a plain object, so `caseTransform` leaves it alone —
  // the generator already emits the snake_case read contract.
  ctx.body = Readable.from(
    streamAuditEntriesNdjson({
      projectIds,
      action: ctx.query.action as string | undefined,
      principalId: ctx.query.principalId as string | undefined,
      resourcePublicId: ctx.query.resourcePublicId as string | undefined,
      resourceSrn: ctx.query.resourceSrn as string | undefined,
      from: parseDate(ctx.query.from),
      to: parseDate(ctx.query.to),
    })
  );
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
