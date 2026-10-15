import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
  validatePlaybook,
} from 'src/lib/playbooks';
import {
  getPlaybookVersion,
  listPlaybookVersions,
  restorePlaybookVersion,
} from 'src/lib/playbookVersions';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
  writePreconditionOf,
} from './helpers';
import { playbookAccess, playbookAuthorOf } from './playbookAccess';
import { playbookCasesRouter } from './playbookCases';
import { playbookExportsRouter } from './playbookExports';

const playbooksRouter = new Router<Context>();

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
 * /api/v1/playbooks/validate:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1validate/post'
 */
playbooksRouter.post('/playbooks/validate', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;
  ctx.body = validatePlaybook({ definition: body.definition });
});

/**
 * @openapi
 * /api/v1/playbooks:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks/post'
 */
playbooksRouter.post('/playbooks', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: parseString(body.project_id),
    action: 'playbooks:CreatePlaybook',
    resourceType: 'playbook',
  });

  ctx.status = 201;
  ctx.body = await createPlaybook({
    projectId: Number(projectId),
    name: body.name,
    description: body.description,
    definition: body.definition,
    versionLabel: parseString(body.version_label),
    createdByUserId: ctx.authUser.id,
    author: playbookAuthorOf(ctx),
  });
});

/**
 * @openapi
 * /api/v1/playbooks:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks/get'
 */
playbooksRouter.get('/playbooks', async (ctx: Context) => {
  requireAuth(ctx);
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'playbooks:ListPlaybooks',
    resourceType: 'playbook',
    projectPublicId: parseString(ctx.query.project_id),
  });

  ctx.body = await listPlaybooks({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}/get'
 */
playbooksRouter.get('/playbooks/:playbook_id', async (ctx: Context) => {
  const { projectIds } = await playbookAccess.authorizeRead({
    ctx,
    action: 'playbooks:GetPlaybook',
  });
  ctx.body = await getPlaybook({ projectIds, id: ctx.params.playbook_id });
});

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}:
 *   patch:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}/patch'
 */
playbooksRouter.patch('/playbooks/:playbook_id', async (ctx: Context) => {
  const { projectIds } = await playbookAccess.authorizeWrite({
    ctx,
    action: 'playbooks:UpdatePlaybook',
  });
  requireAuth(ctx);
  const body = ctx.request.body as Record<string, unknown>;

  ctx.body = await updatePlaybook({
    projectIds,
    id: ctx.params.playbook_id,
    name: body.name,
    description: body.description,
    definition: body.definition,
    versionLabel: parseString(body.version_label),
    expectedVersion: writePreconditionOf(ctx),
    createdByUserId: ctx.authUser.id,
    author: playbookAuthorOf(ctx),
  });
});

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}:
 *   delete:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}/delete'
 */
playbooksRouter.delete('/playbooks/:playbook_id', async (ctx: Context) => {
  const { projectIds } = await playbookAccess.authorizeWrite({
    ctx,
    action: 'playbooks:DeletePlaybook',
  });
  // `204 No Content` leaves the audit middleware no body to backfill from.
  const playbook = await getPlaybook({
    projectIds,
    id: ctx.params.playbook_id,
  });
  setAuditResourceHint(ctx, {
    projectPublicId: playbook.project_id,
    resourceSrn: buildSrn({
      projectPublicId: playbook.project_id,
      resourceType: 'playbook',
      resourceId: playbook.id,
    }),
    resourcePublicId: playbook.id,
  });

  await deletePlaybook({ projectIds, id: ctx.params.playbook_id });
  ctx.status = 204;
});

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}/versions:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}~1versions/get'
 */
playbooksRouter.get(
  '/playbooks/:playbook_id/versions',
  async (ctx: Context) => {
    const { projectIds } = await playbookAccess.authorizeRead({
      ctx,
      action: 'playbooks:ListPlaybookVersions',
    });
    ctx.body = await listPlaybookVersions({
      projectIds,
      playbookId: ctx.params.playbook_id,
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}/versions/{version}:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}~1versions~1{version}/get'
 */
playbooksRouter.get(
  '/playbooks/:playbook_id/versions/:version',
  async (ctx: Context) => {
    const { projectIds } = await playbookAccess.authorizeRead({
      ctx,
      action: 'playbooks:GetPlaybookVersion',
    });
    ctx.body = await getPlaybookVersion({
      projectIds,
      playbookId: ctx.params.playbook_id,
      version: parseVersionParam(ctx.params.version),
    });
  }
);

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}/versions/{version}/restore:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}~1versions~1{version}~1restore/post'
 */
playbooksRouter.post(
  '/playbooks/:playbook_id/versions/:version/restore',
  async (ctx: Context) => {
    const { projectIds } = await playbookAccess.authorizeWrite({
      ctx,
      action: 'playbooks:RestorePlaybookVersion',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.body = await restorePlaybookVersion({
      projectIds,
      playbookId: ctx.params.playbook_id,
      version: parseVersionParam(ctx.params.version),
      label: parseString(body.label),
      createdByUserId: ctx.authUser.id,
      author: playbookAuthorOf(ctx),
    });
  }
);

playbooksRouter.use(playbookCasesRouter.routes());
playbooksRouter.use(playbookCasesRouter.allowedMethods());
playbooksRouter.use(playbookExportsRouter.routes());
playbooksRouter.use(playbookExportsRouter.allowedMethods());

export { playbooksRouter };
