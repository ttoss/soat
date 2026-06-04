import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  getTrace,
  getTraceGenerationIds,
  getTraceTree,
  listTraces,
} from 'src/lib/traces';

export const tracesRouter = new Router<Context>();

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

  ctx.body = result;
});

tracesRouter.get('/traces/:trace_id/generations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'traces:GetTraceGenerations',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await getTraceGenerationIds({
    projectIds,
    traceId: ctx.params.trace_id,
  });

  ctx.body = result;
});
