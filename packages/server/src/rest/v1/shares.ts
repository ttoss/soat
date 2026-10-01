import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { emptyPage } from 'src/lib/pagination';
import {
  acceptShare,
  deleteShare,
  deleteShareAcceptance,
  resumeShare,
  revokeOwnAcceptance,
  revokeShare,
  revokeShareAcceptance,
  suspendShare,
} from 'src/lib/shareLifecycle';
import { listShareReferences } from 'src/lib/shareReferences';
import {
  createShare,
  getShare,
  listPublishedShares,
  listReceivedShares,
  listShareAcceptances,
  updateShare,
} from 'src/lib/shares';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parseEnumListQuery,
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
  resolveWriteProjectPublicId,
} from './helpers';
import { authorizeShareParty, publisherShareAccess } from './shareAccess';

const sharesRouter = new Router<Context>();

const projectIdOf = (ctx: Context): string | undefined => {
  const { project_id: projectPublicId } = ctx.request.body as {
    project_id?: string;
  };
  return projectPublicId;
};

/**
 * @openapi
 * /api/v1/shares:
 *   post:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares/post'
 */
sharesRouter.post('/shares', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    resource: string;
    actions: string[];
    grantee: string;
    cap?: unknown;
  };
  const projectPublicId = resolveWriteProjectPublicId({
    ctx,
    projectPublicId: body.project_id,
  });
  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId,
    action: 'shares:CreateShare',
    resourceType: 'share',
  });

  ctx.status = 201;
  ctx.body = await createShare({
    projectId,
    projectPublicId,
    resource: body.resource,
    actions: body.actions,
    grantee: body.grantee,
    cap: body.cap,
  });
});

/**
 * @openapi
 * /api/v1/shares:
 *   get:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares/get'
 */
sharesRouter.get('/shares', async (ctx: Context) => {
  requireAuth(ctx);
  const projectPublicId = ctx.query.project_id as string | undefined;
  const pagination = parsePagination(ctx);
  const [role] = parseEnumListQuery({
    ctx,
    name: 'role',
    allowed: ['publisher', 'grantee'],
  }) ?? ['publisher'];

  if (role === 'grantee') {
    const granteePublicId = resolveWriteProjectPublicId({
      ctx,
      projectPublicId,
    });
    const projectIds = await resolveReadProjectIds({
      ctx,
      projectPublicId: granteePublicId,
      action: 'shares:ListShares',
      resourceType: 'share',
    });
    ctx.body = projectIds?.length
      ? await listReceivedShares({
          projectId: projectIds[0],
          projectPublicId: granteePublicId,
          ...pagination,
        })
      : emptyPage(pagination);
    return;
  }

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'shares:ListShares',
    resourceType: 'share',
  });
  ctx.body = await listPublishedShares({
    projectIds: projectIds ?? [],
    resource: ctx.query.resource as string | undefined,
    ...pagination,
  });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}:
 *   get:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}/get'
 */
sharesRouter.get('/shares/:share_id', async (ctx: Context) => {
  const party = await authorizeShareParty({
    ctx,
    action: 'shares:GetShare',
    onDenied: 'hide',
    projectPublicId: ctx.query.project_id as string | undefined,
  });
  ctx.body = await getShare({
    id: ctx.params.share_id,
    granteeProjectId: party.side === 'grantee' ? party.projectId : undefined,
  });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/references:
 *   get:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1references/get'
 */
sharesRouter.get('/shares/:share_id/references', async (ctx: Context) => {
  const party = await authorizeShareParty({
    ctx,
    action: 'shares:GetShare',
    onDenied: 'hide',
    projectPublicId: ctx.query.project_id as string | undefined,
  });
  if (party.side === 'publisher') {
    throw new DomainError(
      'VALIDATION_FAILED',
      "References are a grantee's own resources; name the grantee project in project_id.",
      { field: 'project_id' }
    );
  }
  ctx.body = await listShareReferences({
    id: ctx.params.share_id,
    projectId: party.projectId,
  });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}:
 *   patch:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}/patch'
 */
sharesRouter.patch('/shares/:share_id', async (ctx: Context) => {
  await publisherShareAccess.authorizeWrite({
    ctx,
    action: 'shares:UpdateShare',
  });
  const { cap } = ctx.request.body as { cap?: unknown };
  ctx.body = await updateShare({ id: ctx.params.share_id, cap });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}:
 *   delete:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}/delete'
 */
sharesRouter.delete('/shares/:share_id', async (ctx: Context) => {
  const access = await publisherShareAccess.authorizeWrite({
    ctx,
    action: 'shares:DeleteShare',
  });
  // A `204` has no body for the audit middleware to read the SRN from.
  setAuditResourceHint(ctx, {
    projectPublicId: access.projectPublicId,
    resourceSrn: buildSrn({
      projectPublicId: access.projectPublicId,
      resourceType: 'share',
      resourceId: ctx.params.share_id,
    }),
    resourcePublicId: ctx.params.share_id,
  });
  await deleteShare({ id: ctx.params.share_id });
  ctx.status = 204;
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/accept:
 *   post:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1accept/post'
 */
sharesRouter.post('/shares/:share_id/accept', async (ctx: Context) => {
  requireAuth(ctx);
  const party = await authorizeShareParty({
    ctx,
    action: 'shares:AcceptShare',
    onDenied: 'refuse',
    projectPublicId: resolveWriteProjectPublicId({
      ctx,
      projectPublicId: projectIdOf(ctx),
    }),
  });
  if (party.side === 'publisher') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'A project cannot accept its own share; name the grantee project in project_id.',
      { field: 'project_id' }
    );
  }
  ctx.body = await acceptShare({
    id: ctx.params.share_id,
    projectId: party.projectId,
  });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/suspend:
 *   post:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1suspend/post'
 */
sharesRouter.post('/shares/:share_id/suspend', async (ctx: Context) => {
  await publisherShareAccess.authorizeWrite({
    ctx,
    action: 'shares:SuspendShare',
  });
  ctx.body = await suspendShare({ id: ctx.params.share_id });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/resume:
 *   post:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1resume/post'
 */
sharesRouter.post('/shares/:share_id/resume', async (ctx: Context) => {
  await publisherShareAccess.authorizeWrite({
    ctx,
    action: 'shares:SuspendShare',
  });
  ctx.body = await resumeShare({ id: ctx.params.share_id });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/revoke:
 *   post:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1revoke/post'
 */
sharesRouter.post('/shares/:share_id/revoke', async (ctx: Context) => {
  const party = await authorizeShareParty({
    ctx,
    action: 'shares:RevokeShare',
    onDenied: 'refuse',
    projectPublicId: projectIdOf(ctx),
  });
  ctx.body =
    party.side === 'grantee'
      ? await revokeOwnAcceptance({
          id: ctx.params.share_id,
          projectId: party.projectId,
          force: ctx.query.force === 'true',
        })
      : await revokeShare({ id: ctx.params.share_id });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/acceptances:
 *   get:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1acceptances/get'
 */
sharesRouter.get('/shares/:share_id/acceptances', async (ctx: Context) => {
  await publisherShareAccess.authorizeRead({
    ctx,
    action: 'shares:ListShares',
  });
  const [status] =
    parseEnumListQuery({
      ctx,
      name: 'status',
      allowed: ['active', 'revoked'],
    }) ?? [];
  ctx.body = await listShareAcceptances({
    shareId: ctx.params.share_id,
    status: status === 'active' || status === 'revoked' ? status : undefined,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/shares/{share_id}/acceptances/{acceptance_id}/revoke:
 *   post:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1acceptances~1{acceptance_id}~1revoke/post'
 */
sharesRouter.post(
  '/shares/:share_id/acceptances/:acceptance_id/revoke',
  async (ctx: Context) => {
    await publisherShareAccess.authorizeWrite({
      ctx,
      action: 'shares:RevokeShare',
    });
    ctx.body = await revokeShareAcceptance({
      shareId: ctx.params.share_id,
      acceptanceId: ctx.params.acceptance_id,
    });
  }
);

/**
 * @openapi
 * /api/v1/shares/{share_id}/acceptances/{acceptance_id}:
 *   delete:
 *     $ref: 'openapi/v1/shares.yaml#/paths/~1api~1v1~1shares~1{share_id}~1acceptances~1{acceptance_id}/delete'
 */
sharesRouter.delete(
  '/shares/:share_id/acceptances/:acceptance_id',
  async (ctx: Context) => {
    const access = await publisherShareAccess.authorizeWrite({
      ctx,
      action: 'shares:DeleteShare',
    });
    setAuditResourceHint(ctx, {
      projectPublicId: access.projectPublicId,
      resourceSrn: buildSrn({
        projectPublicId: access.projectPublicId,
        resourceType: 'share',
        resourceId: ctx.params.share_id,
      }),
      resourcePublicId: ctx.params.share_id,
    });
    await deleteShareAcceptance({
      shareId: ctx.params.share_id,
      acceptanceId: ctx.params.acceptance_id,
    });
    ctx.status = 204;
  }
);

export { sharesRouter };
