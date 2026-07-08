import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { listUsageMeters } from 'src/lib/usage';

export const usageRouter = new Router<Context>();

/**
 * @openapi
 * GET /api/v1/usage/meters
 * operationId: listUsageMeters
 * Lists raw usage-meter rows the caller can access, optionally filtered by
 * agent_id and generation_id. One row is recorded per completed generation
 * with the provider's reported input/output/cached/reasoning token counts.
 */
usageRouter.get('/usage/meters', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'usage:ListUsageMeters',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { agentId, generationId, limit, offset } = ctx.query as Record<
    string,
    string | undefined
  >;

  const result = await listUsageMeters({
    projectIds: projectIds ?? undefined,
    agentId,
    generationId,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = result;
});
