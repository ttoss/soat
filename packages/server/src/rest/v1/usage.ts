import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { listPrices, upsertPrices } from 'src/lib/priceBook';
import { listUsageMeters } from 'src/lib/usage';

export const usageRouter = new Router<Context>();

type UpsertPricesBody = {
  prices?: Array<{
    provider: string;
    model: string;
    inputPricePerM: number;
    outputPricePerM: number;
    cachedPricePerM?: number | null;
    effectiveFrom: string;
  }>;
};

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

  const { agentId, generationId, traceId, triggerId, actionId, limit, offset } =
    ctx.query as Record<string, string | undefined>;

  const result = await listUsageMeters({
    projectIds: projectIds ?? undefined,
    agentId,
    generationId,
    traceId,
    triggerId,
    actionId,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = result;
});

/**
 * @openapi
 * GET /api/v1/usage/prices
 * operationId: getPriceBook
 * Returns the global price book — the versioned per-provider/model unit prices
 * used to compute usage cost. Readable by any authenticated user.
 */
usageRouter.get('/usage/prices', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  ctx.body = await listPrices();
});

/**
 * @openapi
 * PUT /api/v1/usage/prices
 * operationId: upsertPriceBook
 * Upserts price rows keyed on (provider, model, effective_from). Admin only.
 * effective_from must be in the future — past prices are immutable so recorded
 * costs stay explainable.
 */
usageRouter.put('/usage/prices', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as UpsertPricesBody;
  ctx.body = await upsertPrices({ prices: body.prices ?? [] });
});
