import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { getGeneration } from 'src/lib/generations';

export const generationsRouter = new Router<Context>();

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

  // `metadata` holds internal pending-generation state (messages, tool
  // context) and is intentionally not exposed.
  const { metadata, ...publicGeneration } = generation;
  void metadata;

  ctx.body = publicGeneration;
});
