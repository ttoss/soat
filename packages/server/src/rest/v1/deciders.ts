import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  createDecider,
  deciders,
  deleteDecider,
  getDecider,
  listDeciders,
  updateDecider,
} from 'src/lib/deciders';
import {
  decisions,
  evaluateDecider,
  getDecision,
  listDecisions,
} from 'src/lib/decisions';
import { buildSrn } from 'src/lib/iam';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

export const decidersRouter = new Router<Context>();

const deciderAccess = makeItemRouteAuthorizer({
  findScope: deciders.findScope,
  resourceType: 'decider',
  param: 'decider_id',
  label: 'Decider',
});

const decisionAccess = makeItemRouteAuthorizer({
  findScope: decisions.findScope,
  resourceType: 'decision',
  param: 'decision_id',
  label: 'Decision',
});

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

const resolveDeciderProjectId = async (
  ctx: Context,
  action: string,
  projectPublicId?: string
): Promise<number> => {
  requireAuth(ctx);
  const projectIds = await requireProjectAccess({
    ctx,
    projectPublicId,
    action,
    resourceType: 'decider',
  });
  const targetProjectId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!targetProjectId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }
  return targetProjectId;
};

/**
 * @openapi
 * /api/v1/deciders:
 *   post:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders/post'
 */
decidersRouter.post('/deciders', async (ctx: Context) => {
  const body = ctx.request.body as Record<string, unknown>;
  const { name } = body;

  if (!name || typeof name !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'name is required');
  }

  const targetProjectId = await resolveDeciderProjectId(
    ctx,
    'deciders:CreateDecider',
    body.project_id as string | undefined
  );

  ctx.status = 201;
  ctx.body = await createDecider({
    projectId: Number(targetProjectId),
    name,
    description: parseStringOrUndefined(body.description),
    aiProviderId: body.ai_provider_id,
    model: parseNullableString(body.model),
    questions: body.questions,
  });
});

/**
 * @openapi
 * /api/v1/deciders:
 *   get:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders/get'
 */
decidersRouter.get('/deciders', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'deciders:ListDeciders',
    resourceType: 'decider',
  });

  ctx.body = await listDeciders({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/deciders/{decider_id}:
 *   get:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}/get'
 */
decidersRouter.get('/deciders/:decider_id', async (ctx: Context) => {
  const { projectIds } = await deciderAccess.authorizeRead({
    ctx,
    action: 'deciders:GetDecider',
  });
  ctx.body = await getDecider({ projectIds, id: ctx.params.decider_id });
});

/**
 * @openapi
 * /api/v1/deciders/{decider_id}:
 *   patch:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}/patch'
 */
decidersRouter.patch('/deciders/:decider_id', async (ctx: Context) => {
  const { projectIds } = await deciderAccess.authorizeWrite({
    ctx,
    action: 'deciders:UpdateDecider',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.body = await updateDecider({
    projectIds,
    id: ctx.params.decider_id,
    name: parseStringOrUndefined(body.name),
    description: parseNullableString(body.description),
    aiProviderId: body.ai_provider_id,
    model: parseNullableString(body.model),
    questions: body.questions,
  });
});

/**
 * @openapi
 * /api/v1/deciders/{decider_id}:
 *   delete:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}/delete'
 */
decidersRouter.delete('/deciders/:decider_id', async (ctx: Context) => {
  const { projectIds } = await deciderAccess.authorizeWrite({
    ctx,
    action: 'deciders:DeleteDecider',
  });

  // `204` carries no body for the audit middleware to read the project and SRN
  // from, so the resolved resource is handed over before the row goes.
  const decider = await getDecider({ projectIds, id: ctx.params.decider_id });
  setAuditResourceHint(ctx, {
    projectPublicId: decider.project_id,
    resourceSrn: buildSrn({
      projectPublicId: decider.project_id,
      resourceType: 'decider',
      resourceId: decider.id,
    }),
    resourcePublicId: decider.id,
  });

  await deleteDecider({ projectIds, id: ctx.params.decider_id });

  ctx.status = 204;
});

/**
 * @openapi
 * /api/v1/deciders/{decider_id}/evaluate:
 *   post:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}~1evaluate/post'
 */
decidersRouter.post('/deciders/:decider_id/evaluate', async (ctx: Context) => {
  const { projectIds } = await deciderAccess.authorizeWrite({
    ctx,
    action: 'deciders:EvaluateDecider',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.status = 201;
  ctx.body = await evaluateDecider({
    projectIds,
    id: ctx.params.decider_id,
    state: body.state,
  });
});

/**
 * @openapi
 * /api/v1/decisions:
 *   get:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1decisions/get'
 */
decidersRouter.get('/decisions', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'deciders:ListDecisions',
    resourceType: 'decision',
  });

  ctx.body = await listDecisions({
    projectIds,
    deciderId: ctx.query.decider_id as string | undefined,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/decisions/{decision_id}:
 *   get:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1decisions~1{decision_id}/get'
 */
decidersRouter.get('/decisions/:decision_id', async (ctx: Context) => {
  const { projectIds } = await decisionAccess.authorizeRead({
    ctx,
    action: 'deciders:GetDecision',
  });
  ctx.body = await getDecision({ projectIds, id: ctx.params.decision_id });
});
