import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { findDoc, listDocs } from 'src/lib/docs';

const docsRouter = new Router<Context>();

/**
 * @openapi GET /api/v1/docs
 */
docsRouter.get('/docs', (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  ctx.body = listDocs();
  ctx.status = 200;
});

/**
 * @openapi GET /api/v1/docs/content
 */
docsRouter.get('/docs/content', (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const docPath = ctx.query.path as string | undefined;
  if (!docPath) {
    ctx.status = 400;
    ctx.body = { error: 'path query parameter is required' };
    return;
  }

  const doc = findDoc({ path: docPath });
  if (!doc) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Doc '${docPath}' not found`);
  }

  ctx.body = doc;
  ctx.status = 200;
});

export { docsRouter };
