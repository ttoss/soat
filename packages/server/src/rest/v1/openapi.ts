import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

import { requireAuth } from './helpers';

const openapiRouter = new Router<Context>();

openapiRouter.get('/openapi.json', async (ctx: Context) => {
  requireAuth(ctx);

  ctx.body = getMergedOpenApiSpec();
});

export { openapiRouter };
