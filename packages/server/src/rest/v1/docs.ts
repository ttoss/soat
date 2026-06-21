import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { getDocPage, getDocsIndex } from 'src/lib/docs';

const docsRouter = new Router<Context>();

/**
 * @openapi GET /api/v1/docs
 */
docsRouter.get('/docs', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const content = await getDocsIndex();
  ctx.body = { content };
  ctx.status = 200;
});

/**
 * @openapi GET /api/v1/docs/page
 */
docsRouter.get('/docs/page', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const url = ctx.query.url as string | undefined;
  if (!url) {
    ctx.status = 400;
    ctx.body = { error: 'url query parameter is required' };
    return;
  }

  const content = await getDocPage({ url });
  ctx.body = { url, content };
  ctx.status = 200;
});

export { docsRouter };
