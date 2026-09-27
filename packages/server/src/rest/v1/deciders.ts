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
  getDeciderVersion,
  listDeciderVersions,
  restoreDeciderVersion,
} from 'src/lib/deciderVersions';
import {
  createDecision,
  decisions,
  getDecision,
  listDecisions,
} from 'src/lib/decisions';
import { buildSrn } from 'src/lib/iam';
import { parseMetadataBag } from 'src/lib/metadataBag';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
  writePreconditionOf,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

const decidersRouter = new Router<Context>();

/** Every `/deciders/:decider_id` route authorizes against the decider's SRN. */
const deciderAccess = makeItemRouteAuthorizer({
  findScope: deciders.findScope,
  resourceType: 'decider',
  param: 'decider_id',
  label: 'Decider',
});

/** `/decisions/:decision_id` authorizes against the decision's own SRN. */
const decisionAccess = makeItemRouteAuthorizer({
  findScope: decisions.findScope,
  resourceType: 'decision',
  param: 'decision_id',
  label: 'Decision',
});

const parseString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

/** Path-param `{version}` is a version number, not a public id. */
const parseVersionParam = (raw: string): number => {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'version must be a positive integer.'
    );
  }
  return version;
};

/**
 * @openapi
 * /api/v1/deciders:
 *   post:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders/post'
 */
decidersRouter.post('/deciders', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseString(body.project_id),
    action: 'deciders:CreateDecider',
    resourceType: 'decider',
  });

  ctx.status = 201;
  ctx.body = await createDecider({
    projectId: Number(projectId),
    name: body.name,
    description: body.description,
    agentId: body.agent_id,
    questions: body.questions,
    versionLabel: parseString(body.version_label),
    createdByUserId: ctx.authUser.id,
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
    action: 'deciders:ListDeciders',
    resourceType: 'decider',
    projectPublicId: parseString(ctx.query.project_id),
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
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;

  ctx.body = await updateDecider({
    projectIds,
    id: ctx.params.decider_id,
    name: body.name,
    description: body.description,
    agentId: body.agent_id,
    questions: body.questions,
    versionLabel: parseString(body.version_label),
    expectedVersion: writePreconditionOf(ctx),
    createdByUserId: ctx.authUser.id,
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
  // `204 No Content` leaves the audit middleware no body to backfill from.
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
 * /api/v1/deciders/{decider_id}/versions:
 *   get:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}~1versions/get'
 */
decidersRouter.get('/deciders/:decider_id/versions', async (ctx: Context) => {
  const { projectIds } = await deciderAccess.authorizeRead({
    ctx,
    action: 'deciders:ListDeciderVersions',
  });
  ctx.body = await listDeciderVersions({
    projectIds,
    deciderId: ctx.params.decider_id,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/deciders/{decider_id}/versions/{version}:
 *   get:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}~1versions~1{version}/get'
 */
decidersRouter.get(
  '/deciders/:decider_id/versions/:version',
  async (ctx: Context) => {
    const { projectIds } = await deciderAccess.authorizeRead({
      ctx,
      action: 'deciders:GetDeciderVersion',
    });
    ctx.body = await getDeciderVersion({
      projectIds,
      deciderId: ctx.params.decider_id,
      version: parseVersionParam(ctx.params.version),
    });
  }
);

/**
 * @openapi
 * /api/v1/deciders/{decider_id}/versions/{version}/restore:
 *   post:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}~1versions~1{version}~1restore/post'
 */
decidersRouter.post(
  '/deciders/:decider_id/versions/:version/restore',
  async (ctx: Context) => {
    const { projectIds } = await deciderAccess.authorizeWrite({
      ctx,
      action: 'deciders:RestoreDeciderVersion',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.body = await restoreDeciderVersion({
      projectIds,
      deciderId: ctx.params.decider_id,
      version: parseVersionParam(ctx.params.version),
      label: parseString(body.label),
      createdByUserId: ctx.authUser.id,
    });
  }
);

/**
 * @openapi
 * /api/v1/deciders/{decider_id}/decisions:
 *   post:
 *     $ref: 'openapi/v1/deciders.yaml#/paths/~1api~1v1~1deciders~1{decider_id}~1decisions/post'
 */
decidersRouter.post('/deciders/:decider_id/decisions', async (ctx: Context) => {
  const { projectIds } = await deciderAccess.authorizeWrite({
    ctx,
    action: 'deciders:CreateDecision',
  });
  const body = ctx.request.body as Record<string, unknown>;

  ctx.status = 201;
  ctx.body = await createDecision({
    projectIds,
    deciderId: ctx.params.decider_id,
    state: body.state,
    // Rejected here, before the decision exists: a queued decision answers
    // 201 long before it settles.
    metadata: parseMetadataBag(body.metadata),
    wait: body.wait === true,
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
    action: 'deciders:ListDecisions',
    resourceType: 'decision',
    projectPublicId: parseString(ctx.query.project_id),
  });

  ctx.body = await listDecisions({
    projectIds,
    deciderId: parseString(ctx.query.decider_id),
    status: ctx.query.status,
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

export { decidersRouter };
