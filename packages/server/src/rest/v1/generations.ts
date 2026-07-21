import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  getGeneration,
  listGenerations,
  toPublicGenerationMetadata,
  updateGenerationMetadata,
  validateGenerationMetadata,
} from 'src/lib/generations';

export const generationsRouter = new Router<Context>();

/**
 * @openapi
 * GET /api/v1/generations
 * operationId: listGenerations
 * Lists generations the caller can access, optionally filtered by agent_id,
 * trace_id, and status. Replaces the former GET /traces/{trace_id}/generations.
 */
generationsRouter.get('/generations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'generations:ListGenerations',
    resourceType: 'generation',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { agentId, traceId, initiatorGenerationId, status, limit, offset } =
    ctx.query as Record<string, string | undefined>;

  const result = await listGenerations({
    projectIds: projectIds ?? undefined,
    agentId,
    traceId,
    initiatorGenerationId,
    status,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  ctx.body = {
    ...result,
    data: result.data.map((gen) => {
      return { ...gen, metadata: toPublicGenerationMetadata(gen.metadata) };
    }),
  };
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
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'generations:GetGeneration',
    resourceType: 'generation',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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

  ctx.body = {
    ...generation,
    metadata: toPublicGenerationMetadata(generation.metadata),
  };
});

/**
 * @openapi
 * PATCH /api/v1/generations/{generation_id}
 * operationId: updateGeneration
 * Attaches caller-supplied key/value metadata to a generation, for per-run
 * audit attribution (e.g. which knowledge-corpus version produced an action).
 * The provided keys are shallow-merged over the existing metadata; system-owned
 * keys (usage attribution, memory-extraction summary) are preserved and cannot
 * be overwritten.
 */
generationsRouter.patch('/generations/:generation_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    action: 'generations:UpdateGeneration',
    resourceType: 'generation',
  });

  if (
    projectIds === null ||
    (Array.isArray(projectIds) && projectIds.length === 0)
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { metadata } = ctx.request.body as { metadata?: unknown };

  const metadataError = validateGenerationMetadata(metadata);
  if (metadataError) {
    ctx.status = 400;
    ctx.body = { error: metadataError };
    return;
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

  ctx.body = {
    ...generation,
    metadata: toPublicGenerationMetadata(generation.metadata),
  };
});
