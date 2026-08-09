import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeTraceContent } from 'src/lib/contentPurge';
import { getTrace, getTraceTree, listTraces } from 'src/lib/traces';

import {
  requestPrincipalFromCtx,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
} from './helpers';

export const tracesRouter = new Router<Context>();

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
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'traces:GetTrace',
    resourceType: 'trace',
  });

  const result = await getTrace({
    projectIds,
    traceId: ctx.params.trace_id,
  });

  ctx.body = result;
});

tracesRouter.get('/traces/:trace_id/tree', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'traces:GetTraceTree',
    resourceType: 'trace',
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
  requireAuth(ctx);

  // An empty scope means the action is denied everywhere, which must answer 403
  // rather than the 404 an empty filter would produce — see
  // `requireProjectAccess`.
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'traces:PurgeTraceContent',
    resourceType: 'trace',
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
