import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { createEmbeddings } from 'src/lib/embeddings';
import { EMBEDDING_SPEND } from 'src/lib/embeddingSpend';
import { MAX_EMBEDDINGS_INPUTS } from 'src/lib/requestBounds';

import {
  requireAuth,
  resolveWriteProjectId,
  resolveWriteProjectPublicId,
} from './helpers';

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

  // Every embedding is billed to a project, so a call names one or carries a
  // credential bound to one. An explicit `project_id` is authorized like any
  // project-scoped write; the bound project needs no such check, since the
  // credential can act nowhere else.
  const billingProjectPublicId = resolveWriteProjectPublicId({
    ctx,
    projectPublicId: body.project_id,
  });
  if (body.project_id) {
    await resolveWriteProjectId({
      ctx,
      projectPublicId: body.project_id,
      ...EMBEDDING_SPEND,
    });
  }

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
