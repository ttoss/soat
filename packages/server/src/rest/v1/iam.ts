import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { checkIamPermission } from 'src/lib/iamCheck';
import { discardAuthorizationChecks } from 'src/middleware/audit';

import { requireAuth } from './helpers';

const iamRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/iam.yaml
 */
iamRouter.post('/iam/check', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    action?: unknown;
    resource?: unknown;
    context?: { tags?: unknown };
  };
  ctx.body = await checkIamPermission({
    isAllowed: ctx.authUser.isAllowed,
    action: body.action,
    resource: body.resource,
    tags: body.context?.tags,
  });
  discardAuthorizationChecks(ctx);
});

export { iamRouter };
