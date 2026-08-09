import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { evaluateGuardrailDryRun } from 'src/lib/guardrailDryRun';
import {
  createGuardrail,
  deleteGuardrail,
  getGuardrail,
  listGuardrails,
  updateGuardrail,
} from 'src/lib/guardrails';
import {
  getGuardrailVersion,
  listGuardrailVersions,
  restoreGuardrailVersion,
} from 'src/lib/guardrailVersions';
import { buildSrn } from 'src/lib/iam';
import { setAuditResourceHint } from 'src/middleware/audit';

import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';
import { coerceToJsonObject } from './tools';

export const guardrailsRouter = new Router<Context>();

const parseStringOrUndefined = (v: unknown): string | undefined => {
  return typeof v === 'string' ? v : undefined;
};

const parseNullableString = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return undefined;
};

const DOCUMENT_ERROR = 'document must be a JSON object';

/** Path-param `{version}` is a version *number*, not a public ID. */
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

const resolveGuardrailProjectId = async (
  ctx: Context,
  action: string,
  projectPublicId?: string
): Promise<number> => {
  requireAuth(ctx);
  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action,
    resourceType: 'guardrail',
  });
  const targetProjectId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!targetProjectId) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required');
  }
  return targetProjectId;
};

/**
 * @openapi
 * /api/v1/guardrails:
 *   post:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails/post'
 */
guardrailsRouter.post('/guardrails', async (ctx: Context) => {
  const body = ctx.request.body as Record<string, unknown>;
  const { name, description } = body;
  const projectPublicId = body.project_id as string | undefined;

  if (!name || typeof name !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'name is required');
  }

  const targetProjectId = await resolveGuardrailProjectId(
    ctx,
    'guardrails:CreateGuardrail',
    projectPublicId
  );
  if (!targetProjectId) return;

  let document: object | null | undefined;
  try {
    document = coerceToJsonObject(body.document);
  } catch {
    throw new DomainError('VALIDATION_FAILED', DOCUMENT_ERROR);
  }
  if (!document) {
    throw new DomainError('VALIDATION_FAILED', DOCUMENT_ERROR);
  }

  const result = await createGuardrail({
    projectId: Number(targetProjectId),
    name,
    description: parseStringOrUndefined(description),
    document,
    contextToolId: parseNullableString(body.context_tool_id),
    contextMode: parseNullableString(body.context_mode),
    versionLabel: parseStringOrUndefined(body.version_label),
    createdByUserId: ctx.authUser?.id,
  });

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /api/v1/guardrails:
 *   get:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails/get'
 */
guardrailsRouter.get('/guardrails', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'guardrails:ListGuardrails',
    resourceType: 'guardrail',
  });

  ctx.body = await listGuardrails({ projectIds, ...parsePagination(ctx) });
});

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}:
 *   get:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}/get'
 */
guardrailsRouter.get('/guardrails/:guardrail_id', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'guardrails:GetGuardrail',
    resourceType: 'guardrail',
  });
  ctx.body = await getGuardrail({
    projectIds,
    id: ctx.params.guardrail_id,
  });
});

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}:
 *   patch:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}/patch'
 */
guardrailsRouter.patch('/guardrails/:guardrail_id', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'guardrails:UpdateGuardrail',
    resourceType: 'guardrail',
  });
  const body = ctx.request.body as Record<string, unknown>;

  let document: object | null | undefined;
  try {
    document = coerceToJsonObject(body.document);
  } catch {
    throw new DomainError('VALIDATION_FAILED', DOCUMENT_ERROR);
  }

  ctx.body = await updateGuardrail({
    projectIds,
    id: ctx.params.guardrail_id,
    name: parseStringOrUndefined(body.name),
    description: parseNullableString(body.description),
    document: document ?? undefined,
    contextToolId: parseNullableString(body.context_tool_id),
    contextMode: parseNullableString(body.context_mode),
    versionLabel: parseStringOrUndefined(body.version_label),
    createdByUserId: ctx.authUser?.id,
  });
});

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}:
 *   delete:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}/delete'
 */
guardrailsRouter.delete('/guardrails/:guardrail_id', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'guardrails:DeleteGuardrail',
    resourceType: 'guardrail',
  });
  // The success response is `204 No Content`, so the audit middleware has no
  // body to backfill the project/SRN from — hand it the resolved resource
  // before the delete runs (see `setAuditResourceHint`).
  const guardrail = await getGuardrail({
    projectIds,
    id: ctx.params.guardrail_id,
  });
  setAuditResourceHint(ctx, {
    projectPublicId: guardrail.project_id,
    resourceSrn: buildSrn({
      projectPublicId: guardrail.project_id,
      resourceType: 'guardrail',
      resourceId: guardrail.id,
    }),
    resourcePublicId: guardrail.id,
  });

  await deleteGuardrail({
    projectIds,
    id: ctx.params.guardrail_id,
  });

  ctx.status = 204;
});

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}/evaluate:
 *   post:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}~1evaluate/post'
 */
guardrailsRouter.post(
  '/guardrails/:guardrail_id/evaluate',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'guardrails:EvaluateGuardrail',
      resourceType: 'guardrail',
    });
    const body = ctx.request.body as Record<string, unknown>;
    const args = coerceToJsonObject(body.args) ?? undefined;
    const guardrailContext =
      coerceToJsonObject(body.guardrail_context) ?? undefined;

    ctx.body = await evaluateGuardrailDryRun({
      projectIds,
      guardrailId: ctx.params.guardrail_id,
      args,
      guardrailContext,
      toolId: parseStringOrUndefined(body.tool_id),
      authHeader: (ctx.headers.authorization as string) ?? '',
    });
  }
);

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}/versions:
 *   get:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}~1versions/get'
 */
guardrailsRouter.get(
  '/guardrails/:guardrail_id/versions',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'guardrails:ListGuardrailVersions',
      resourceType: 'guardrail',
    });
    ctx.body = await listGuardrailVersions({
      projectIds,
      guardrailId: ctx.params.guardrail_id,
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}/versions/{version}:
 *   get:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}~1versions~1{version}/get'
 */
guardrailsRouter.get(
  '/guardrails/:guardrail_id/versions/:version',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'guardrails:GetGuardrailVersion',
      resourceType: 'guardrail',
    });
    ctx.body = await getGuardrailVersion({
      projectIds,
      guardrailId: ctx.params.guardrail_id,
      version: parseVersionParam(ctx.params.version),
    });
  }
);

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}/versions/{version}/restore:
 *   post:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}~1versions~1{version}~1restore/post'
 */
guardrailsRouter.post(
  '/guardrails/:guardrail_id/versions/:version/restore',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'guardrails:RestoreGuardrailVersion',
      resourceType: 'guardrail',
    });
    const body = ctx.request.body as { label?: unknown };

    ctx.body = await restoreGuardrailVersion({
      projectIds,
      guardrailId: ctx.params.guardrail_id,
      version: parseVersionParam(ctx.params.version),
      label: typeof body.label === 'string' ? body.label : undefined,
      createdByUserId: ctx.authUser?.id,
    });
  }
);
