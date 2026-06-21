import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { createEmbeddings } from 'src/lib/embeddings';

const embeddingsRouter = new Router<Context>();

/**
 * @openapi embeddings.yaml
 */
embeddingsRouter.post('/embeddings', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const body = ctx.request.body as {
    input?: string;
    inputs?: string[];
  };

  const hasSingle = typeof body.input === 'string';
  const hasBatch = Array.isArray(body.inputs) && body.inputs.length > 0;

  if (!hasSingle && !hasBatch) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'At least one of `input` (string) or `inputs` (string[]) is required.'
    );
  }

  const response: { embedding?: number[]; embeddings?: number[][] } = {};

  if (hasSingle) {
    const results = await createEmbeddings({ inputs: [body.input!] });
    response.embedding = results[0];
  }

  if (hasBatch) {
    response.embeddings = await createEmbeddings({ inputs: body.inputs! });
  }

  ctx.status = 200;
  ctx.body = response;
});

export { embeddingsRouter };
