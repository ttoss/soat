import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { createEmbeddings } from 'src/lib/embeddings';
import { MAX_EMBEDDINGS_INPUTS } from 'src/lib/requestBounds';

import { requireAuth, resolveWriteProjectId } from './helpers';

const embeddingsRouter = new Router<Context>();

type EmbeddingsBody = { input?: string; inputs?: string[] };

const assertEmbeddingsRequest = (
  body: EmbeddingsBody
): { hasSingle: boolean; hasBatch: boolean } => {
  const hasSingle = typeof body.input === 'string';
  const hasBatch = Array.isArray(body.inputs) && body.inputs.length > 0;

  if (
    Array.isArray(body.inputs) &&
    body.inputs.length > MAX_EMBEDDINGS_INPUTS
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `\`inputs\` carries ${body.inputs.length} values, over the ${MAX_EMBEDDINGS_INPUTS} per request this route accepts. Split the batch.`
    );
  }

  if (!hasSingle && !hasBatch) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'At least one of `input` (string) or `inputs` (string[]) is required.'
    );
  }

  return { hasSingle, hasBatch };
};

/**
 * @openapi embeddings.yaml
 */
embeddingsRouter.post('/embeddings', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as EmbeddingsBody & { project_id?: string };

  const { hasSingle, hasBatch } = assertEmbeddingsRequest(body);

  // Billing attribution only — this route's authorization is unchanged. An
  // explicit `project_id` is authorized like any project-scoped write, because
  // spend must never be attributed to a project the caller cannot write to; the
  // project a scoped credential is *bound* to needs no such check, since the
  // credential can act nowhere else. Neither, and the call is not metered.
  const projectPublicId =
    ctx.authUser.apiKeyProjectPublicId ??
    ctx.authUser.oauthProjectPublicId ??
    null;

  if (body.project_id) {
    await resolveWriteProjectId({
      ctx,
      projectPublicId: body.project_id,
      action: 'embeddings:CreateEmbeddings',
      resourceType: 'embedding',
    });
  }

  const billingProjectPublicId = body.project_id ?? projectPublicId;

  const response: { embedding?: number[]; embeddings?: number[][] } = {};

  if (hasSingle) {
    const results = await createEmbeddings({
      inputs: [body.input!],
      projectPublicId: billingProjectPublicId,
    });
    response.embedding = results[0];
  }

  if (hasBatch) {
    response.embeddings = await createEmbeddings({
      inputs: body.inputs!,
      projectPublicId: billingProjectPublicId,
    });
  }

  ctx.status = 200;
  ctx.body = response;
});

export { embeddingsRouter };
