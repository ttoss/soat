import { Readable } from 'node:stream';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  getAuditEntry,
  listAuditEntries,
  streamAuditEntriesNdjson,
} from 'src/lib/auditLog';

const auditLogRouter = new Router<Context>();

// Absent is not the same as invalid: a filter the caller never supplied is
// simply not applied (`undefined`), but one supplied and unparseable throws
// rather than being silently dropped — an unparseable `from`/`to` must never
// widen a query into "every entry" without the caller knowing (audit-log#691).
const parseDateParam = (args: {
  value: unknown;
  paramName: string;
}): Date | undefined => {
  if (typeof args.value !== 'string' || args.value.length === 0) {
    return undefined;
  }
  const date = new Date(args.value);
  if (Number.isNaN(date.getTime())) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${args.paramName}' is not a valid ISO 8601 date: '${args.value}'.`
    );
  }
  return date;
};

// Mirrors parseDateParam: absent stays undefined (the default applies further
// down), but a supplied, non-numeric value throws rather than reaching
// Sequelize as `NaN`, which the driver rejects with a bare 500 (audit-log#707).
const parseIntParam = (args: {
  value: unknown;
  paramName: string;
}): number | undefined => {
  if (typeof args.value !== 'string' || args.value.length === 0) {
    return undefined;
  }
  const parsed = Number(args.value);
  if (!Number.isFinite(parsed)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `'${args.paramName}' is not a valid number: '${args.value}'.`
    );
  }
  return parsed;
};

auditLogRouter.get('/audit-log', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.project_id as string | undefined;

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
    principalId: ctx.query.principal_id as string | undefined,
    resourcePublicId: ctx.query.resource_public_id as string | undefined,
    resourceSrn: ctx.query.resource_srn as string | undefined,
    from: parseDateParam({ value: ctx.query.from, paramName: 'from' }),
    to: parseDateParam({ value: ctx.query.to, paramName: 'to' }),
    limit: parseIntParam({ value: ctx.query.limit, paramName: 'limit' }),
    offset: parseIntParam({ value: ctx.query.offset, paramName: 'offset' }),
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

  const projectPublicId = ctx.query.project_id as string | undefined;

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
  // The generator emits the snake_case read contract directly.
  ctx.body = Readable.from(
    streamAuditEntriesNdjson({
      projectIds,
      action: ctx.query.action as string | undefined,
      principalId: ctx.query.principal_id as string | undefined,
      resourcePublicId: ctx.query.resource_public_id as string | undefined,
      resourceSrn: ctx.query.resource_srn as string | undefined,
      from: parseDateParam({ value: ctx.query.from, paramName: 'from' }),
      to: parseDateParam({ value: ctx.query.to, paramName: 'to' }),
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
