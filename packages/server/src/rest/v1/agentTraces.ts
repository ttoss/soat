import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getTrace, listTraces } from 'src/lib/agents';

export const agentTracesRouter = new Router<Context>();

/**
 * @openapi GET /agents/traces
 */
agentTracesRouter.get('/agents/traces', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agents:ListAgentTraces',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listTraces({ projectIds });
});

/**
 * @openapi GET /agents/traces/:trace_id
 */
agentTracesRouter.get('/agents/traces/:trace_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'agents:GetAgentTrace',
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
