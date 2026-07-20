import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { evaluateGuardrailDryRun } from 'src/lib/guardrailDryRun';
import {
  createGuardrail,
  deleteGuardrail,
  getGuardrail,
  getGuardrailVersion,
  listGuardrails,
  updateGuardrail,
} from 'src/lib/guardrails';

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

const resolveGuardrailProjectId = async (
  ctx: Context,
  action: string,
  projectPublicId?: string
): Promise<number | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action,
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  const targetProjectId = projectIds?.[0] ?? ctx.authUser.apiKeyProjectId;
  if (!targetProjectId) {
    ctx.status = 400;
    ctx.body = { error: 'projectId is required' };
    return null;
  }
  return targetProjectId;
};

const checkGuardrailsAccess = async (
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
 * /api/v1/guardrails:
 *   post:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails/post'
 */
guardrailsRouter.post('/guardrails', async (ctx: Context) => {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const { name, description } = body;
  const projectPublicId = body.projectId as string | undefined;

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
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
    contextToolId: parseNullableString(body.contextToolId),
    contextMode: parseNullableString(body.contextMode),
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'guardrails:ListGuardrails',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listGuardrails({ projectIds });
});

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}:
 *   get:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}/get'
 */
guardrailsRouter.get('/guardrails/:guardrail_id', async (ctx: Context) => {
  const projectIds = await checkGuardrailsAccess(
    ctx,
    'guardrails:GetGuardrail'
  );
  if (projectIds === null) return;

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
  const projectIds = await checkGuardrailsAccess(
    ctx,
    'guardrails:UpdateGuardrail'
  );
  if (projectIds === null) return;

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;

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
    contextToolId: parseNullableString(body.contextToolId),
    contextMode: parseNullableString(body.contextMode),
  });
});

/**
 * @openapi
 * /api/v1/guardrails/{guardrail_id}:
 *   delete:
 *     $ref: 'openapi/v1/guardrails.yaml#/paths/~1api~1v1~1guardrails~1{guardrail_id}/delete'
 */
guardrailsRouter.delete('/guardrails/:guardrail_id', async (ctx: Context) => {
  const projectIds = await checkGuardrailsAccess(
    ctx,
    'guardrails:DeleteGuardrail'
  );
  if (projectIds === null) return;

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
    const projectIds = await checkGuardrailsAccess(
      ctx,
      'guardrails:EvaluateGuardrail'
    );
    if (projectIds === null) return;

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const args = coerceToJsonObject(body.args) ?? undefined;
    const guardrailContext =
      coerceToJsonObject(body.guardrailContext) ?? undefined;

    ctx.body = await evaluateGuardrailDryRun({
      projectIds,
      guardrailId: ctx.params.guardrail_id,
      args,
      guardrailContext,
      toolId: parseStringOrUndefined(body.toolId),
      authHeader: (ctx.headers.authorization as string) ?? '',
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
    const projectIds = await checkGuardrailsAccess(
      ctx,
      'guardrails:GetGuardrailVersion'
    );
    if (projectIds === null) return;

    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'version must be a positive integer.'
      );
    }

    ctx.body = await getGuardrailVersion({
      projectIds,
      guardrailId: ctx.params.guardrail_id,
      version,
    });
  }
);
