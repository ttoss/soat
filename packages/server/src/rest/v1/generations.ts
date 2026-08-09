import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { purgeGenerationContent } from 'src/lib/contentPurge';
import { validateGenerationMetadata } from 'src/lib/generationMetadata';
import {
  getGeneration,
  listGenerations,
  updateGenerationMetadata,
} from 'src/lib/generations';

import {
  requestPrincipalFromCtx,
  requireAuth,
  requireProjectAccess,
} from './helpers';

export const generationsRouter = new Router<Context>();

/**
 * @openapi
 * GET /api/v1/generations
 * operationId: listGenerations
 * Lists generations the caller can access, optionally filtered by agent_id,
 * trace_id, and status. Replaces the former GET /traces/{trace_id}/generations.
 */
generationsRouter.get('/generations', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'generations:ListGenerations',
    resourceType: 'generation',
  });

  const {
    agent_id: agentId,
    trace_id: traceId,
    initiator_generation_id: initiatorGenerationId,
    status,
    limit,
    offset,
  } = ctx.query as Record<string, string | undefined>;

  const result = await listGenerations({
    projectIds: projectIds ?? undefined,
    agentId,
    traceId,
    initiatorGenerationId,
    status,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = result;
});

/**
 * @openapi
 * GET /api/v1/generations/{generation_id}
 * operationId: getGeneration
 * Returns a single generation record by public ID, including its status
 * ('in_progress', 'requires_action', 'completed', or 'failed') and the
 * structured error payload when the generation failed.
 */
generationsRouter.get('/generations/:generation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'generations:GetGeneration',
    resourceType: 'generation',
  });

  const generation = await getGeneration({
    publicId: ctx.params.generation_id,
    projectIds,
  });

  if (!generation) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${ctx.params.generation_id}' not found.`
    );
  }

  ctx.body = generation;
});

/**
 * @openapi
 * PATCH /api/v1/generations/{generation_id}
 * operationId: updateGeneration
 * Attaches caller-supplied key/value metadata to a generation, for per-run
 * audit attribution (e.g. which knowledge-corpus version produced an action).
 * The provided keys are shallow-merged over the existing metadata. The bag is
 * caller-owned: server state (usage attribution, the served agent version, the
 * model route's record, the memory-extraction summary) lives in its own
 * top-level fields and cannot be reached from here.
 */
generationsRouter.patch('/generations/:generation_id', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await requireProjectAccess({
    ctx,
    action: 'generations:UpdateGeneration',
    resourceType: 'generation',
  });

  const { metadata } = ctx.request.body as { metadata?: unknown };

  const metadataError = validateGenerationMetadata(metadata);
  if (metadataError) {
    throw new DomainError('VALIDATION_FAILED', metadataError);
  }

  const generation = await updateGenerationMetadata({
    publicId: ctx.params.generation_id,
    projectIds: projectIds ?? undefined,
    metadata: metadata as Record<string, unknown>,
  });

  if (!generation) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${ctx.params.generation_id}' not found.`
    );
  }

  ctx.body = generation;
});

/**
 * @openapi
 * DELETE /api/v1/generations/{generation_id}/content
 * operationId: purgeGenerationContent
 * Clears the generation's content (`metadata`, `error`, `extraction`, and the
 * internal recovery state), leaving the usage/audit skeleton — ids, timestamps,
 * status, and the attribution fields the billing ledger reads. Idempotent.
 */
generationsRouter.delete(
  '/generations/:generation_id/content',
  async (ctx: Context) => {
    requireAuth(ctx);

    const projectIds = await requireProjectAccess({
      ctx,
      action: 'generations:PurgeGenerationContent',
      resourceType: 'generation',
    });

    const purged = await purgeGenerationContent({
      publicId: ctx.params.generation_id,
      projectIds,
      principal: requestPrincipalFromCtx(ctx),
    });

    if (!purged) {
      throw new DomainError(
        'RESOURCE_NOT_FOUND',
        `Generation '${ctx.params.generation_id}' not found.`
      );
    }

    ctx.body = purged;
  }
);
