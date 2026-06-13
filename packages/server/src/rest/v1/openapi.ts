import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

const openapiRouter = new Router<Context>();

openapiRouter.get('/openapi.json', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  ctx.body = getMergedOpenApiSpec();
});

export { openapiRouter };
