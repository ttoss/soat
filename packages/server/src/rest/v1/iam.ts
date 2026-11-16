import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { callerDenied } from 'src/lib/authorizationDenial';
import { checkIamPermission } from 'src/lib/iamCheck';
import { assertIamTokenIssuer, createIamToken } from 'src/lib/iamTokens';
import { revokePrincipal } from 'src/lib/principalRevocations';
import {
  discardAuthorizationChecks,
  recordAuthorizationDecision,
} from 'src/middleware/audit';

import { requireAuth, resolveWriteProjectId } from './helpers';

const iamRouter = new Router<Context>();

const projectSrn = (args: {
  projectPublicId: string;
  resourceType: string;
}): string => {
  return `srn:${args.projectPublicId}:${args.resourceType}:*`;
};

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
  const action = 'iam:CreateToken';
  const issuer = assertIamTokenIssuer({
    authUser: ctx.authUser,
    onRefused: () => {
      recordAuthorizationDecision(ctx, { action, allowed: false });
    },
  });
  const { projectPublicId } = issuer;
  const resource = projectSrn({ projectPublicId, resourceType: 'iam_token' });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId,
    action,
    resource,
  });
  if (!allowed) {
    throw callerDenied({ authUser: ctx.authUser, action, resource });
  }
  ctx.status = 201;
  ctx.body = await createIamToken({
    issuer,
    body: ctx.request.body as Record<string, unknown>,
  });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/iam.yaml
 */
iamRouter.post('/iam/principal-revocations', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    principal?: unknown;
  };
  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'iam:RevokePrincipal',
    resourceType: 'iam_principal',
  });
  await revokePrincipal({ projectId, principal: body.principal });
  ctx.status = 204;
});

export { iamRouter };
