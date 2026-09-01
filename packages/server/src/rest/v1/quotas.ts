import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import {
  createQuota,
  deleteQuota,
  getQuota,
  listQuotas,
  updateQuota,
} from 'src/lib/quotas';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const quotasRouter = new Router<Context>();

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

/**
 * @openapi
 * /api/v1/quotas:
 *   post:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas/post'
 */
quotasRouter.post('/quotas', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseStringOrUndefined(body.project_id),
    action: 'quotas:CreateQuota',
    resourceType: 'quota',
  });
  const result = await createQuota({
    projectId: Number(targetProjectId),
    scope: body.scope as string,
    scopeRef: parseNullableString(body.scope_ref),
    metric: body.metric as string,
    window: body.window as string,
    limit: body.limit,
    mode: parseStringOrUndefined(body.mode),
    onUnpriced: parseStringOrUndefined(body.on_unpriced),
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
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'quotas:ListQuotas',
    resourceType: 'quota',
  });

  ctx.body = await listQuotas({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/quotas/{quota_id}:
 *   get:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas~1{quota_id}/get'
 */
quotasRouter.get('/quotas/:quota_id', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'quotas:GetQuota',
    resourceType: 'quota',
  });
  ctx.body = await getQuota({ projectIds, id: ctx.params.quota_id });
});

/**
 * @openapi
 * /api/v1/quotas/{quota_id}:
 *   patch:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas~1{quota_id}/patch'
 */
quotasRouter.patch('/quotas/:quota_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'quotas:UpdateQuota',
    resourceType: 'quota',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.body = await updateQuota({
    projectIds,
    id: ctx.params.quota_id,
    limit: body.limit,
    mode: parseStringOrUndefined(body.mode),
    onUnpriced: parseStringOrUndefined(body.on_unpriced),
  });
});

/**
 * @openapi
 * /api/v1/quotas/{quota_id}:
 *   delete:
 *     $ref: 'openapi/v1/quotas.yaml#/paths/~1api~1v1~1quotas~1{quota_id}/delete'
 */
quotasRouter.delete('/quotas/:quota_id', async (ctx: Context) => {
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'quotas:DeleteQuota',
    resourceType: 'quota',
  });
  // The success response is `204 No Content`, so the audit middleware has no
  // body to backfill the project/SRN from — hand it the resolved resource
  // before the delete runs (see `setAuditResourceHint`).
  const quota = await getQuota({ projectIds, id: ctx.params.quota_id });
  setAuditResourceHint(ctx, {
    projectPublicId: quota.project_id,
    resourceSrn: buildSrn({
      projectPublicId: quota.project_id,
      resourceType: 'quota',
      resourceId: quota.id,
    }),
    resourcePublicId: quota.id,
  });

  await deleteQuota({ projectIds, id: ctx.params.quota_id });

  ctx.status = 204;
});

export { quotasRouter };
