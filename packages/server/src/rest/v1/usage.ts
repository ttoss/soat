import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { listPrices, upsertPrices } from 'src/lib/priceBook';
import {
  aggregateUsage,
  createThreshold,
  deleteThreshold,
  getReceipt,
  getRunReceipt,
  listThresholds,
  listUsageEvents,
} from 'src/lib/usage';

import { checkAuth, parsePagination, resolveWriteProjectId } from './helpers';

export const usageRouter = new Router<Context>();

type UpsertPricesBody = {
  prices?: Array<{
    aiProviderId?: string | null;
    meterType?: string;
    provider: string;
    model: string;
    component: string;
    unit: string;
    unitPrice: number;
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
    resourceType: 'usage',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const {
    agentId,
    generationId,
    traceId,
    triggerId,
    actionId,
    meterType,
    limit,
    offset,
  } = ctx.query as Record<string, string | undefined>;

  const result = await listUsageEvents({
    projectIds: projectIds ?? undefined,
    agentId,
    generationId,
    traceId,
    triggerId,
    actionId,
    meterType,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = result;
});

/**
 * @openapi
 * GET /api/v1/usage
 * operationId: getUsage
 * Returns a project's usage rolled up over an optional [from, to] window,
 * bucketed by one dimension (group_by=model|agent|run|day|meter_type). Each
 * group and the grand total carry summed token counts and cost_usd. Requires
 * usage:GetUsage on the project.
 */
usageRouter.get('/usage', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  // The caseTransform middleware camelCases query keys, so `project_id` and
  // `group_by` arrive as `projectId` / `groupBy`.
  const {
    projectId: projectPublicId,
    from,
    to,
    groupBy,
  } = ctx.query as Record<string, string | undefined>;

  if (!projectPublicId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'project_id query parameter is required.'
    );
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'usage:GetUsage',
    resourceType: 'usage',
  });

  if (
    projectIds === null ||
    projectIds === undefined ||
    projectIds.length === 0
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = await aggregateUsage({
    projectId: projectIds[0],
    projectPublicId,
    from,
    to,
    groupBy,
  });
});

/**
 * @openapi
 * GET /api/v1/usage/thresholds
 * operationId: listUsageThresholds
 * Lists the usage thresholds the caller can access, optionally filtered by
 * project_id. Each threshold alerts (via the usage.threshold_crossed webhook)
 * when a project's cost or token usage over a calendar-month or rolling-24h
 * window crosses the configured value. Requires usage:ListThresholds.
 */
usageRouter.get('/usage/thresholds', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'usage:ListThresholds',
    resourceType: 'usage',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const { projectId } = ctx.query as Record<string, string | undefined>;

  ctx.body = await listThresholds({
    projectIds: projectIds ?? undefined,
    projectId,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * POST /api/v1/usage/thresholds
 * operationId: createUsageThreshold
 * Creates a usage threshold on a project. metric is cost_usd or tokens; window
 * is calendar_month or rolling_24h; threshold is the value to cross. Thresholds
 * are immutable apart from deletion. Requires usage:ManageThresholds.
 */
usageRouter.post('/usage/thresholds', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    metric?: string;
    window?: string;
    threshold?: number;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'usage:ManageThresholds',
    resourceType: 'usage',
  });
  if (targetProjectId === null) return;

  if (
    body.metric === undefined ||
    body.window === undefined ||
    body.threshold === undefined
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'metric, window, and threshold are required.'
    );
  }

  ctx.status = 201;
  ctx.body = await createThreshold({
    projectId: Number(targetProjectId),
    metric: body.metric,
    window: body.window,
    threshold: body.threshold,
  });
});

/**
 * @openapi
 * DELETE /api/v1/usage/thresholds/{threshold_id}
 * operationId: deleteUsageThreshold
 * Deletes a usage threshold, resetting its fire state. Requires
 * usage:ManageThresholds.
 */
usageRouter.delete('/usage/thresholds/:threshold_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'usage:ManageThresholds',
    resourceType: 'usage',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  const deleted = await deleteThreshold({
    id: ctx.params.threshold_id,
    projectIds: projectIds ?? undefined,
  });
  if (!deleted) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Usage threshold '${ctx.params.threshold_id}' not found.`
    );
  }

  ctx.status = 204;
});

// Resolves the receipt for either addressing mode (run_id or generation_id, the
// two mutually exclusive). Throws VALIDATION_FAILED when neither is supplied and
// RESOURCE_NOT_FOUND when the addressed resource is not visible in scope.
const resolveReceipt = async (args: {
  generationId?: string;
  runId?: string;
  projectIds?: number[];
}) => {
  if (args.runId) {
    const receipt = await getRunReceipt({
      runId: args.runId,
      projectIds: args.projectIds,
    });
    if (!receipt) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Orchestration run '${args.runId}' not found.`
      );
    }
    return receipt;
  }

  if (!args.generationId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'generation_id or run_id query parameter is required.'
    );
  }

  const receipt = await getReceipt({
    generationId: args.generationId,
    projectIds: args.projectIds,
  });
  if (!receipt) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${args.generationId}' not found.`
    );
  }
  return receipt;
};

/**
 * @openapi
 * GET /api/v1/usage/receipt
 * operationId: getUsageReceipt
 * Returns a billing receipt. Pass generation_id for a per-generation receipt or
 * run_id for a per-run receipt summed across the orchestration run's meters —
 * both share the same shape (per-model line items with tokens, the price-book
 * version that priced them, and cost, plus totals).
 */
usageRouter.get('/usage/receipt', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'usage:GetReceipt',
    resourceType: 'usage',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { generationId, runId } = ctx.query as Record<
    string,
    string | undefined
  >;

  ctx.body = await resolveReceipt({
    generationId,
    runId,
    projectIds: projectIds ?? undefined,
  });
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
