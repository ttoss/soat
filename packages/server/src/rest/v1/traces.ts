import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeTraceContent } from 'src/lib/contentPurge';
import { getTrace, getTraceTree, listTraces, traceRows } from 'src/lib/traces';

import {
  requestPrincipalFromCtx,
  requireAuth,
  resolveReadProjectIds,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

export const tracesRouter = new Router<Context>();

/**
 * Every `/traces/:trace_id` route authorizes against the trace's own SRN rather
 * than the project wildcard a statement naming one trace can never match.
 */
const traceAccess = makeItemRouteAuthorizer({
  findScope: traceRows.findScope,
  resourceType: 'trace',
  param: 'trace_id',
  label: 'Trace',
});

tracesRouter.get('/traces', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'traces:ListTraces',
    resourceType: 'trace',
  });

  const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
  const offset = ctx.query.offset ? Number(ctx.query.offset) : undefined;

  ctx.body = await listTraces({ projectIds, limit, offset });
});

tracesRouter.get('/traces/:trace_id', async (ctx: Context) => {
  const { projectIds } = await traceAccess.authorizeRead({
    ctx,
    action: 'traces:GetTrace',
  });

  const result = await getTrace({
    projectIds,
    traceId: ctx.params.trace_id,
  });

  ctx.body = result;
});

tracesRouter.get('/traces/:trace_id/tree', async (ctx: Context) => {
  const { projectIds } = await traceAccess.authorizeRead({
    ctx,
    action: 'traces:GetTraceTree',
  });

  const includeParam = ctx.query.include as string | undefined;
  const include = includeParam
    ? includeParam.split(',').map((s) => {
        return s.trim();
      })
    : undefined;

  const result = await getTraceTree({
    projectIds,
    traceId: ctx.params.trace_id,
    include,
  });

  ctx.body = result;
});

/**
 * @openapi
 * DELETE /api/v1/traces/{trace_id}/content
 * operationId: purgeTraceContent
 * Purges the trace's content: deletes its steps object from storage and clears
 * the content columns, cascading to descendant traces and to their generations.
 * The row survives as an auditable skeleton with `content_redacted_at` set, so
 * the erasure is provable rather than a 404 that proves nothing. Idempotent.
 */
tracesRouter.delete('/traces/:trace_id/content', async (ctx: Context) => {
  const { projectIds } = await traceAccess.authorizeWrite({
    ctx,
    action: 'traces:PurgeTraceContent',
  });

  const purged = await purgeTraceContent({
    traceId: ctx.params.trace_id,
    projectIds,
    principal: requestPrincipalFromCtx(ctx),
  });

  if (!purged) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Trace '${ctx.params.trace_id}' not found.`
    );
  }

  ctx.body = purged;
});
