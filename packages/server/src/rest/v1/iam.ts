import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { checkIamPermission } from 'src/lib/iamCheck';
import {
  assertIamTokenIssuer,
  createIamToken,
  IAM_TOKEN_ACTION,
} from 'src/lib/iamTokens';
import {
  discardAuthorizationChecks,
  recordAuthorizationDecision,
} from 'src/middleware/audit';

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

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/iam.yaml
 */
iamRouter.post('/iam/tokens', async (ctx: Context) => {
  requireAuth(ctx);
  const issuer = assertIamTokenIssuer({
    authUser: ctx.authUser,
    onRefused: () => {
      recordAuthorizationDecision(ctx, {
        action: IAM_TOKEN_ACTION,
        allowed: false,
      });
    },
  });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: issuer.projectPublicId,
    action: IAM_TOKEN_ACTION,
    resource: `srn:${issuer.projectPublicId}:iam_token:*`,
  });
  if (!allowed) throw new DomainError('FORBIDDEN', 'Forbidden');
  ctx.status = 201;
  ctx.body = await createIamToken({
    issuer,
    body: (ctx.request.body ?? {}) as Record<string, unknown>,
  });
});

export { iamRouter };
