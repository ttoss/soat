import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeTraceContent } from 'src/lib/contentPurge';
import { getTrace, getTraceTree, listTraces } from 'src/lib/traces';

import {
  requestPrincipalFromCtx,
  resolveProjectIdsWithAction,
} from './helpers';

export const tracesRouter = new Router<Context>();

tracesRouter.get('/traces', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'traces:ListTraces',
    resourceType: 'trace',
  });

  if (projectIds === null) return;

  const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
  const offset = ctx.query.offset ? Number(ctx.query.offset) : undefined;

  ctx.body = await listTraces({ projectIds, limit, offset });
});

tracesRouter.get('/traces/:trace_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'traces:GetTrace',
    resourceType: 'trace',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getTrace({
    projectIds,
    traceId: ctx.params.trace_id,
  });

  ctx.body = result;
});

tracesRouter.get('/traces/:trace_id/tree', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'traces:GetTraceTree',
    resourceType: 'trace',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'traces:PurgeTraceContent',
    resourceType: 'trace',
  });

  // A plain user JWT with no `project_id` on the request resolves to the set of
  // projects the caller may act on, which is `[]` — not null — when the action
  // is denied everywhere. Both mean "not permitted", so both are 403; treating
  // only null as denial would answer 404 and read as "no such trace".
  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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
