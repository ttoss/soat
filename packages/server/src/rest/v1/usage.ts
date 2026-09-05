import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { listPrices, upsertPrices } from 'src/lib/priceBook';
import {
  aggregateUsage,
  createThreshold,
  deleteThreshold,
  getReceipt,
  getRunReceipt,
  getThreshold,
  listThresholds,
  listUsageEvents,
} from 'src/lib/usage';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireAdmin,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

export const usageRouter = new Router<Context>();

type UpsertPricesBody = {
  prices?: Array<{
    ai_provider_id?: string | null;
    meter_type?: string;
    provider: string;
    model: string;
    component: string;
    unit: string;
    unit_price: number;
    effective_from: string;
  }>;
};

/**
 * @openapi
 * GET /api/v1/usage/meters
 * operationId: listUsageMeters
 * Lists raw usage-meter rows the caller can access, optionally filtered by
 * agent_id, generation_id, trace_id, actor_id, session_id, and source. One row
 * is recorded per completed generation with the provider's reported
 * input/output/cached/reasoning token counts.
 */
usageRouter.get('/usage/meters', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'usage:ListUsageMeters',
    resourceType: 'usage',
  });

  const {
    agent_id: agentId,
    generation_id: generationId,
    trace_id: traceId,
    actor_id: actorId,
    session_id: sessionId,
    trigger_id: triggerId,
    action_id: actionId,
    meter_type: meterType,
    source,
    limit,
    offset,
  } = ctx.query as Record<string, string | undefined>;

  const result = await listUsageEvents({
    projectIds: projectIds ?? undefined,
    agentId,
    generationId,
    traceId,
    actorId,
    sessionId,
    triggerId,
    actionId,
    meterType,
    source,
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
 * bucketed by one dimension
 * (group_by=model|ai_provider|agent|run|day|meter_type|actor|session|source)
 * and optionally narrowed to a single meter_type. Each group and the grand
 * total carry an event count, summed token counts, a measured quantity per
 * component, and cost_usd. groups is paginated with limit/offset; its total is
 * the number of distinct buckets, while totals always describes the whole
 * window. Requires usage:GetUsage on the project.
 */
usageRouter.get('/usage', async (ctx: Context) => {
  requireAuth(ctx);

  const {
    project_id: projectPublicId,
    from,
    to,
    group_by: groupBy,
    meter_type: meterType,
  } = ctx.query as Record<string, string | undefined>;

  if (!projectPublicId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'project_id query parameter is required.'
    );
  }

  const projectIds = await resolveReadProjectIds({
    ctx,
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
    meterType,
    ...parsePagination(ctx),
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
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'usage:ListThresholds',
    resourceType: 'usage',
  });

  const { project_id: projectId } = ctx.query as Record<
    string,
    string | undefined
  >;

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
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    metric?: string;
    window?: string;
    threshold?: number;
  };

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'usage:ManageThresholds',
    resourceType: 'usage',
  });
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
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'usage:ManageThresholds',
    resourceType: 'usage',
  });

  // The success response is `204 No Content`, so the audit middleware has no
  // body to backfill the project/SRN from — hand it the resolved resource
  // before the delete runs (see `setAuditResourceHint`).
  const threshold = await getThreshold({
    id: ctx.params.threshold_id,
    projectIds: projectIds ?? undefined,
  });
  if (threshold.project_id) {
    setAuditResourceHint(ctx, {
      projectPublicId: threshold.project_id,
      resourceSrn: buildSrn({
        projectPublicId: threshold.project_id,
        resourceType: 'usage',
        resourceId: threshold.id,
      }),
      resourcePublicId: threshold.id,
    });
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

// Resolves the receipt for either addressing mode (orchestration_run_id or generation_id, the
// two mutually exclusive). Throws VALIDATION_FAILED when neither is supplied and
// RESOURCE_NOT_FOUND when the addressed resource is not visible in scope.
const resolveReceipt = async (args: {
  generationId?: string;
  orchestrationRunId?: string;
  projectIds?: number[];
}) => {
  if (args.orchestrationRunId && args.generationId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'generation_id and orchestration_run_id are mutually exclusive — supply exactly one.'
    );
  }

  if (args.orchestrationRunId) {
    const receipt = await getRunReceipt({
      orchestrationRunId: args.orchestrationRunId,
      projectIds: args.projectIds,
    });
    if (!receipt) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Orchestration run '${args.orchestrationRunId}' not found.`
      );
    }
    return receipt;
  }

  if (!args.generationId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'generation_id or orchestration_run_id query parameter is required.'
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
 * orchestration_run_id for a per-run receipt summed across the orchestration run's meters —
 * both share the same shape (per-model line items with tokens, the price-book
 * version that priced them, and cost, plus totals).
 */
usageRouter.get('/usage/receipt', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'usage:GetReceipt',
    resourceType: 'usage',
  });

  const {
    generation_id: generationId,
    orchestration_run_id: orchestrationRunId,
  } = ctx.query as Record<string, string | undefined>;

  ctx.body = await resolveReceipt({
    generationId,
    orchestrationRunId,
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
  requireAuth(ctx);

  ctx.body = await listPrices();
});

/**
 * @openapi
 * PUT /api/v1/usage/prices
 * operationId: upsertPriceBook
 * Upserts price rows keyed on (provider, model, effective_from). Admin only.
 * effective_from must be in the future once the (provider, model, component) is
 * priced — past prices are immutable so recorded costs stay explainable. A
 * first price may be dated now or earlier.
 */
usageRouter.put('/usage/prices', async (ctx: Context) => {
  requireAdmin(ctx, 'usage:ManagePriceBook');
  const body = ctx.request.body as UpsertPricesBody;
  ctx.body = await upsertPrices({
    prices: (body.prices ?? []).map((price) => {
      return {
        aiProviderId: price.ai_provider_id,
        meterType: price.meter_type,
        provider: price.provider,
        model: price.model,
        component: price.component,
        unit: price.unit,
        unitPrice: price.unit_price,
        effectiveFrom: price.effective_from,
      };
    }),
  });
});
