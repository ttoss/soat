import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createQuota,
  deleteQuota,
  getQuota,
  listQuotas,
  updateQuota,
} from 'src/lib/quotas';

import { checkAuth, resolveWriteProjectId } from './helpers';

const quotasRouter = new Router<Context>();

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

const checkQuotasAccess = async (
  ctx: Context,
  action: string
): Promise<number[] | undefined | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({ action });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return projectIds;
};

/**
 * @openapi
 * /api/v1/quotas:
 *   post:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas/post'
 */
quotasRouter.post('/quotas', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseStringOrUndefined(body.projectId),
    action: 'quotas:CreateQuota',
  });
  if (targetProjectId === null) return;

  const result = await createQuota({
    projectId: Number(targetProjectId),
    scope: body.scope as string,
    scopeRef: parseNullableString(body.scopeRef),
    metric: body.metric as string,
    window: body.window as string,
    limit: body.limit,
    mode: parseStringOrUndefined(body.mode),
  });

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /api/v1/quotas:
 *   get:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas/get'
 */
quotasRouter.get('/quotas', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'quotas:ListQuotas',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listQuotas({ projectIds });
});

/**
 * @openapi
 * /api/v1/quotas/{quota_id}:
 *   get:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas~1{quota_id}/get'
 */
quotasRouter.get('/quotas/:quota_id', async (ctx: Context) => {
  const projectIds = await checkQuotasAccess(ctx, 'quotas:GetQuota');
  if (projectIds === null) return;

  ctx.body = await getQuota({ projectIds, id: ctx.params.quota_id });
});

/**
 * @openapi
 * /api/v1/quotas/{quota_id}:
 *   patch:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas~1{quota_id}/patch'
 */
quotasRouter.patch('/quotas/:quota_id', async (ctx: Context) => {
  const projectIds = await checkQuotasAccess(ctx, 'quotas:UpdateQuota');
  if (projectIds === null) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;

  ctx.body = await updateQuota({
    projectIds,
    id: ctx.params.quota_id,
    limit: body.limit,
    mode: parseStringOrUndefined(body.mode),
  });
});

/**
 * @openapi
 * /api/v1/quotas/{quota_id}:
 *   delete:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas~1{quota_id}/delete'
 */
quotasRouter.delete('/quotas/:quota_id', async (ctx: Context) => {
  const projectIds = await checkQuotasAccess(ctx, 'quotas:DeleteQuota');
  if (projectIds === null) return;

  await deleteQuota({ projectIds, id: ctx.params.quota_id });

  ctx.status = 204;
});

export { quotasRouter };
