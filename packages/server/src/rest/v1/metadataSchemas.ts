import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import {
  checkDocumentMetadata,
  createMetadataSchema,
  deleteMetadataSchema,
  getMetadataSchema,
  listMetadataSchemas,
  metadataSchemas,
  updateMetadataSchema,
} from 'src/lib/metadataSchemas';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  parsePagination,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

const metadataSchemasRouter = new Router<Context>();

/**
 * Every `/metadata-schemas/:metadata_schema_id` route authorizes against the
 * declaration's own SRN rather than the project wildcard a statement naming one
 * declaration can never match.
 */
const metadataSchemaAccess = makeItemRouteAuthorizer({
  findScope: metadataSchemas.findScope,
  resourceType: 'metadata_schema',
  param: 'metadata_schema_id',
  label: 'Metadata schema',
});

type WriteBody = {
  project_id?: string;
  resource_type?: unknown;
  path_prefix?: unknown;
  schema?: unknown;
};

metadataSchemasRouter.get('/metadata-schemas', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'metadata-schemas:ListMetadataSchemas',
    resourceType: 'metadata_schema',
  });

  ctx.body = await listMetadataSchemas({
    projectIds,
    resourceType: ctx.query.resource_type as string | undefined,
    ...parsePagination(ctx),
  });
});

metadataSchemasRouter.post('/metadata-schemas', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as WriteBody;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'metadata-schemas:CreateMetadataSchema',
    resourceType: 'metadata_schema',
  });

  ctx.status = 201;
  ctx.body = await createMetadataSchema({
    projectId: Number(targetProjectId),
    resourceType: body.resource_type,
    pathPrefix: body.path_prefix,
    schema: body.schema,
  });
});

/**
 * @openapi
 * POST /api/v1/metadata-schemas/validate
 * operationId: validateMetadata
 * Answers what a write would be told, without writing: a caller preparing a
 * batch learns which declaration would refuse it, and why, before it sends
 * anything.
 */
metadataSchemasRouter.post(
  '/metadata-schemas/validate',
  async (ctx: Context) => {
    requireAuth(ctx);
    // `path` is required by the spec, so `strictFields` refuses a body
    // without one before the handler runs.
    const body = ctx.request.body as {
      project_id?: string;
      path: string;
      metadata?: Record<string, unknown> | null;
    };

    // A read of what is declared, so it is the listing grant rather than the
    // one that declares — and an empty scope is a refusal here, because the
    // answer would otherwise read as "nothing governs this".
    const projectIds = await requireProjectAccess({
      ctx,
      projectPublicId: body.project_id,
      action: 'metadata-schemas:ListMetadataSchemas',
      resourceType: 'metadata_schema',
    });

    ctx.body = await checkDocumentMetadata({
      projectPublicId: body.project_id,
      projectIds,
      path: body.path,
      metadata: body.metadata ?? null,
    });
  }
);

metadataSchemasRouter.get(
  '/metadata-schemas/:metadata_schema_id',
  async (ctx: Context) => {
    const { projectIds } = await metadataSchemaAccess.authorizeRead({
      ctx,
      action: 'metadata-schemas:GetMetadataSchema',
    });

    ctx.body = await getMetadataSchema({
      id: ctx.params.metadata_schema_id,
      projectIds,
    });
  }
);

metadataSchemasRouter.patch(
  '/metadata-schemas/:metadata_schema_id',
  async (ctx: Context) => {
    const { projectIds } = await metadataSchemaAccess.authorizeWrite({
      ctx,
      action: 'metadata-schemas:UpdateMetadataSchema',
    });
    const body = ctx.request.body as WriteBody;

    ctx.body = await updateMetadataSchema({
      id: ctx.params.metadata_schema_id,
      projectIds,
      pathPrefix: body.path_prefix,
      schema: body.schema,
    });
  }
);

metadataSchemasRouter.delete(
  '/metadata-schemas/:metadata_schema_id',
  async (ctx: Context) => {
    const { projectIds } = await metadataSchemaAccess.authorizeWrite({
      ctx,
      action: 'metadata-schemas:DeleteMetadataSchema',
    });

    // The success response is `204 No Content`, so the audit middleware has no
    // body to backfill the project/SRN from — hand it the resolved resource
    // before the delete runs.
    const declaration = await getMetadataSchema({
      id: ctx.params.metadata_schema_id,
      projectIds,
    });
    /* istanbul ignore else -- the accessor loads the project with the row, so a
       declaration always names one. */
    if (declaration.project_id) {
      setAuditResourceHint(ctx, {
        projectPublicId: declaration.project_id,
        resourceSrn: buildSrn({
          projectPublicId: declaration.project_id,
          resourceType: 'metadata_schema',
          resourceId: declaration.id,
        }),
        resourcePublicId: declaration.id,
      });
    }

    await deleteMetadataSchema({
      id: ctx.params.metadata_schema_id,
      projectIds,
    });
    ctx.status = 204;
  }
);

export { metadataSchemasRouter };
