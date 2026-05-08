import { Router } from '@ttoss/http-server';

import type { Context } from 'src/Context';
import { getTrace, getTraceTree, listTraces } from 'src/lib/traces';

export const tracesRouter = new Router<Context>();

/**
 * @openapi GET /traces
 */
tracesRouter.get('/traces', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'traces:ListTraces',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
  const offset = ctx.query.offset ? Number(ctx.query.offset) : undefined;

  ctx.body = await listTraces({ projectIds, limit, offset });
});

/**
 * @openapi GET /traces/:trace_id
 */
tracesRouter.get('/traces/:trace_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'traces:GetTrace',
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

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Trace not found' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi GET /traces/:trace_id/tree
 */
tracesRouter.get('/traces/:trace_id/tree', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'traces:GetTraceTree',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getTraceTree({
    projectIds,
    traceId: ctx.params.trace_id,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Trace not found' };
    return;
  }

  ctx.body = result;
});
