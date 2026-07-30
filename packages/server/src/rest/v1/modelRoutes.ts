import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import {
  createModelRoute,
  deleteModelRoute,
  getModelRoute,
  listModelRoutes,
  updateModelRoute,
} from 'src/lib/modelRoutes';
import { setAuditResourceHint } from 'src/middleware/audit';

import { checkAuth, parsePagination, resolveWriteProjectId } from './helpers';

const modelRoutesRouter = new Router<Context>();

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

const checkModelRoutesAccess = async (
  ctx: Context,
  action: string
): Promise<number[] | undefined | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({
    action,
    resourceType: 'model_route',
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return projectIds;
};

/**
 * @openapi
 * /api/v1/model-routes:
 *   post:
 *     $ref: 'openapi/v1/model-routes.yaml#/paths/~1api~1v1~1model-routes/post'
 */
modelRoutesRouter.post('/model-routes', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseStringOrUndefined(body.project_id),
    action: 'model-routes:CreateModelRoute',
    resourceType: 'model_route',
  });
  if (targetProjectId === null) return;

  ctx.status = 201;
  ctx.body = await createModelRoute({
    projectId: Number(targetProjectId),
    name: body.name,
    targets: body.targets,
    retryOn: body.retry_on,
    failureThreshold: body.failure_threshold,
    cooldownSeconds: body.cooldown_seconds,
  });
});

/**
 * @openapi
 * /api/v1/model-routes:
 *   get:
 *     $ref: 'openapi/v1/model-routes.yaml#/paths/~1api~1v1~1model-routes/get'
 */
modelRoutesRouter.get('/model-routes', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'model-routes:ListModelRoutes',
    resourceType: 'model_route',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listModelRoutes({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/model-routes/{route_id}:
 *   get:
 *     $ref: 'openapi/v1/model-routes.yaml#/paths/~1api~1v1~1model-routes~1{route_id}/get'
 */
modelRoutesRouter.get('/model-routes/:route_id', async (ctx: Context) => {
  const projectIds = await checkModelRoutesAccess(
    ctx,
    'model-routes:GetModelRoute'
  );
  if (projectIds === null) return;

  ctx.body = await getModelRoute({ projectIds, id: ctx.params.route_id });
});

/**
 * @openapi
 * /api/v1/model-routes/{route_id}:
 *   put:
 *     $ref: 'openapi/v1/model-routes.yaml#/paths/~1api~1v1~1model-routes~1{route_id}/put'
 */
modelRoutesRouter.put('/model-routes/:route_id', async (ctx: Context) => {
  const projectIds = await checkModelRoutesAccess(
    ctx,
    'model-routes:UpdateModelRoute'
  );
  if (projectIds === null) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;

  ctx.body = await updateModelRoute({
    projectIds,
    id: ctx.params.route_id,
    name: body.name,
    targets: body.targets,
    retryOn: body.retry_on,
    failureThreshold: body.failure_threshold,
    cooldownSeconds: body.cooldown_seconds,
  });
});

/**
 * @openapi
 * /api/v1/model-routes/{route_id}:
 *   delete:
 *     $ref: 'openapi/v1/model-routes.yaml#/paths/~1api~1v1~1model-routes~1{route_id}/delete'
 */
modelRoutesRouter.delete('/model-routes/:route_id', async (ctx: Context) => {
  const projectIds = await checkModelRoutesAccess(
    ctx,
    'model-routes:DeleteModelRoute'
  );
  if (projectIds === null) return;

  // `204 No Content` leaves the audit middleware no body to backfill from, so
  // hand it the resolved resource before the delete runs.
  const route = await getModelRoute({ projectIds, id: ctx.params.route_id });
  setAuditResourceHint(ctx, {
    projectPublicId: route.project_id,
    resourceSrn: buildSrn({
      projectPublicId: route.project_id,
      resourceType: 'model_route',
      resourceId: route.id,
    }),
    resourcePublicId: route.id,
  });

  await deleteModelRoute({ projectIds, id: ctx.params.route_id });

  ctx.status = 204;
});

export { modelRoutesRouter };
