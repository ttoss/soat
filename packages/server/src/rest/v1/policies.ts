import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { PolicyDocument } from 'src/lib/iam';
import {
  createPolicy,
  deletePolicy,
  findPolicyScope,
  getPolicy,
  listPolicies,
  updatePolicy,
} from 'src/lib/policies';

import {
  isUnrestrictedAdmin,
  parsePagination,
  requireAdmin,
  requireAuth,
  requireProjectAccess,
  resolveWriteProjectId,
  resolveWriteProjectPublicId,
} from './helpers';
import { authorizeResource } from './resourceAccess';

const policiesRouter = new Router<Context>();

/**
 * Whether a request concerns one project's policies rather than the global
 * set: it names a project, or its credential is bound to one.
 */
const targetsProject = (args: {
  ctx: Context;
  projectPublicId?: string;
}): boolean => {
  const { authUser } = args.ctx;
  return (
    args.projectPublicId !== undefined ||
    authUser?.apiKeyProjectPublicId !== undefined ||
    authUser?.oauthProjectPublicId !== undefined
  );
};

/**
 * A project policy authorizes against its own SRN; a global one, and every
 * policy for the unrestricted admin, stays behind the admin gate.
 */
const authorizePolicy = async (args: {
  ctx: Context;
  action: string;
  onDenied: 'hide' | 'refuse';
}): Promise<void> => {
  const { ctx } = args;
  requireAuth(ctx);
  const policyId = ctx.params.policy_id;
  if (isUnrestrictedAdmin(ctx.authUser)) {
    requireAdmin(ctx, args.action);
    return;
  }
  const found = await findPolicyScope({ policyId });
  if (found?.scope == null) {
    requireAdmin(ctx, args.action);
    return;
  }
  await authorizeResource({
    ctx,
    scope: found.scope,
    resourceType: 'policy',
    resourceId: policyId,
    action: args.action,
    onDenied: args.onDenied,
    label: 'Policy',
  });
};

const throwIfInvalid = <T extends object>(
  result: T | { invalid: true; errors: string[] }
): T => {
  if ('invalid' in result) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid policy document', {
      details: result.errors,
    });
  }
  return result;
};

policiesRouter.get('/policies', async (ctx: Context) => {
  const action = 'policies:ListPolicies';
  const userId = ctx.query.user_id as string | undefined;
  const projectPublicId = ctx.query.project_id as string | undefined;
  requireAuth(ctx);

  if (userId !== undefined || !targetsProject({ ctx, projectPublicId })) {
    requireAdmin(ctx, action);
  }
  const projectIds =
    projectPublicId !== undefined || !isUnrestrictedAdmin(ctx.authUser)
      ? await requireProjectAccess({
          ctx,
          projectPublicId,
          action,
          resourceType: 'policy',
        })
      : undefined;
  if (projectIds === undefined) requireAdmin(ctx, action);

  ctx.body = await listPolicies({
    userId,
    projectIds,
    ...parsePagination(ctx),
  });
});

policiesRouter.post('/policies', async (ctx: Context) => {
  const action = 'policies:CreatePolicy';
  const body = ctx.request.body as {
    project_id?: string;
    name?: string;
    description?: string;
    document?: object;
  };
  requireAuth(ctx);

  let project: { id: number; publicId: string } | undefined;
  if (targetsProject({ ctx, projectPublicId: body.project_id })) {
    project = {
      id: await resolveWriteProjectId({
        ctx,
        projectPublicId: body.project_id,
        action,
        resourceType: 'policy',
      }),
      publicId: resolveWriteProjectPublicId({
        ctx,
        projectPublicId: body.project_id,
      }),
    };
  } else {
    requireAdmin(ctx, action);
  }

  ctx.status = 201;
  ctx.body = throwIfInvalid(
    await createPolicy({
      name: body.name,
      description: body.description,
      document: body.document as PolicyDocument,
      project,
    })
  );
});

policiesRouter.get('/policies/:policy_id', async (ctx: Context) => {
  await authorizePolicy({
    ctx,
    action: 'policies:GetPolicy',
    onDenied: 'hide',
  });
  const policy = await getPolicy({ policyId: ctx.params.policy_id });

  if (!policy) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Policy not found');
  }

  ctx.body = policy;
});

policiesRouter.put('/policies/:policy_id', async (ctx: Context) => {
  await authorizePolicy({
    ctx,
    action: 'policies:UpdatePolicy',
    onDenied: 'refuse',
  });
  requireAuth(ctx);
  const { name, description, document } = ctx.request.body as {
    name?: string;
    description?: string;
    document: object;
  };

  ctx.body = throwIfInvalid(
    await updatePolicy({
      policyId: ctx.params.policy_id,
      name,
      description,
      document: document as PolicyDocument,
      writerPolicies: ctx.authUser.getPolicies,
    })
  );
});

policiesRouter.delete('/policies/:policy_id', async (ctx: Context) => {
  await authorizePolicy({
    ctx,
    action: 'policies:DeletePolicy',
    onDenied: 'refuse',
  });
  await deletePolicy({ policyId: ctx.params.policy_id });

  ctx.status = 204;
});

export { policiesRouter };
