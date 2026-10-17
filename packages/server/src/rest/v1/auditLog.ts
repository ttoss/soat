import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  auditEntries,
  getAuditEntry,
  listAuditEntries,
  streamAuditEntriesNdjson,
} from 'src/lib/auditLog';

import {
  parseDateQuery,
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
} from './helpers';
import { sendNdjson } from './ndjsonResponse';
import { makeItemRouteAuthorizer } from './resourceAccess';

const auditLogRouter = new Router<Context>();

/**
 * Every `/audit-log/:entry_id` route authorizes against the entry's own SRN rather than the
 * project wildcard a statement naming one entry can never match.
 */
const auditEntryAccess = makeItemRouteAuthorizer({
  findScope: auditEntries.findScope,
  resourceType: 'audit',
  param: 'entry_id',
  label: 'Audit entry',
});

auditLogRouter.get('/audit-log', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'audit:ListAuditEntries',
    resourceType: 'audit',
  });

  ctx.body = await listAuditEntries({
    projectIds,
    action: ctx.query.action as string | undefined,
    principalId: ctx.query.principal_id as string | undefined,
    resourcePublicId: ctx.query.resource_public_id as string | undefined,
    resourceSrn: ctx.query.resource_srn as string | undefined,
    from: parseDateQuery({ ctx, name: 'from' }),
    to: parseDateQuery({ ctx, name: 'to' }),
    ...parsePagination(ctx),
  });
});

// Registered before `/audit-log/:entry_id` so `export` is matched as a literal
// path segment rather than swallowed as an entry id.
auditLogRouter.get('/audit-log/export', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  // Export is deliberately per-project: an unbounded cross-project dump is a
  // different (and much larger) egress surface than this endpoint offers.
  if (!projectPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'audit:ExportAuditEntries',
    resourceType: 'audit',
  });

  // The generator emits the snake_case read contract directly.
  sendNdjson({
    ctx,
    filename: `audit-log-${projectPublicId}.ndjson`,
    lines: streamAuditEntriesNdjson({
      projectIds,
      action: ctx.query.action as string | undefined,
      principalId: ctx.query.principal_id as string | undefined,
      resourcePublicId: ctx.query.resource_public_id as string | undefined,
      resourceSrn: ctx.query.resource_srn as string | undefined,
      from: parseDateQuery({ ctx, name: 'from' }),
      to: parseDateQuery({ ctx, name: 'to' }),
    }),
  });
});

auditLogRouter.get('/audit-log/:entry_id', async (ctx: Context) => {
  const { projectIds } = await auditEntryAccess.authorizeRead({
    ctx,
    action: 'audit:GetAuditEntry',
  });

  ctx.body = await getAuditEntry({ id: ctx.params.entry_id, projectIds });
});

export { auditLogRouter };
