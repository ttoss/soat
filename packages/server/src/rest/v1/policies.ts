import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { PolicyDocument } from 'src/lib/iam';
import { readsShowing } from 'src/lib/permissionCatalog';
import {
  createPolicy,
  deletePolicy,
  findPolicyScope,
  getPolicy,
  listPolicies,
  updatePolicy,
} from 'src/lib/policies';

import {
  type AuthenticatedContext,
  parsePagination,
  requireAdmin,
  requireAuth,
  requireProjectAccess,
  resolveWriteProjectId,
  resolveWriteProjectPublicId,
} from './helpers';
import { authorizeProjectGroup } from './projectGroupAccess';
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

/** The project group action each policy action is on a project group policy. */
const PROJECT_GROUP_POLICY_ACTIONS: Readonly<Record<string, string>> = {
  'policies:ListPolicies': 'project-groups:ListPolicies',
  'policies:CreatePolicy': 'project-groups:CreatePolicy',
  'policies:GetPolicy': 'project-groups:GetPolicy',
  'policies:UpdatePolicy': 'project-groups:UpdatePolicy',
  'policies:DeletePolicy': 'project-groups:DeletePolicy',
};

/**
 * The project group a policy request names, once the caller may take the
 * project group action `action` maps to on its policies (`policyId` one of
 * them).
 */
const authorizeProjectGroupPolicy = (args: {
  ctx: AuthenticatedContext;
  projectGroupPublicId: string;
  action: string;
  policyId?: string;
}) => {
  return authorizeProjectGroup({
    ctx: args.ctx,
    projectGroupPublicId: args.projectGroupPublicId,
    action: PROJECT_GROUP_POLICY_ACTIONS[args.action],
    projectGroupType: 'policy',
    resourceId: args.policyId,
  });
};

const refuseProjectGroupWith = (field: string): DomainError => {
  return new DomainError(
    'VALIDATION_FAILED',
    `project_group_id and ${field} are mutually exclusive.`
  );
};

/**
 * A project group policy authorizes as a project group action, a project
 * policy against its own SRN; a global one, and every policy for the
 * unrestricted admin, stays behind the admin gate.
 */
const authorizePolicy = async (args: {
  ctx: Context;
  action: string;
  onDenied: 'hide' | 'refuse';
}): Promise<void> => {
  const { ctx } = args;
  requireAuth(ctx);
  const policyId = ctx.params.policy_id;
  if (ctx.authUser.unrestricted) {
    await requireAdmin(ctx, args.action);
    return;
  }
  const found = await findPolicyScope({ policyId });
  if (found === null) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Policy not found');
  }
  if ('projectGroupPublicId' in found) {
    await authorizeProjectGroupPolicy({
      ctx,
      projectGroupPublicId: found.projectGroupPublicId,
      action: args.action,
      policyId,
    });
    return;
  }
  if (found.scope === null) {
    await requireAdmin(ctx, args.action);
    return;
  }
  await authorizeResource({
    ctx,
    scope: found.scope,
    resourceType: 'policy',
    shownBy: readsShowing({ module: 'policies', noun: 'Policy' }),
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
  const projectGroupPublicId = ctx.query.project_group_id as string | undefined;
  requireAuth(ctx);

  if (projectGroupPublicId !== undefined) {
    if (projectPublicId !== undefined)
      throw refuseProjectGroupWith('project_id');
    if (userId !== undefined) throw refuseProjectGroupWith('user_id');
    const group = await authorizeProjectGroupPolicy({
      ctx,
      projectGroupPublicId,
      action,
    });
    ctx.body = await listPolicies({
      projectGroupId: group.id as number,
      ...parsePagination(ctx),
    });
    return;
  }

  if (userId !== undefined || !targetsProject({ ctx, projectPublicId })) {
    await requireAdmin(ctx, action);
  }
  const projectIds =
    projectPublicId !== undefined || !ctx.authUser.unrestricted
      ? await requireProjectAccess({
          ctx,
          projectPublicId,
          action,
          resourceType: 'policy',
        })
      : undefined;
  if (projectIds === undefined) await requireAdmin(ctx, action);

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
    project_group_id?: string;
    name?: string;
    description?: string;
    document?: object;
  };
  requireAuth(ctx);

  let project: { id: number; publicId: string } | undefined;
  let projectGroup: { id: number; publicId: string } | undefined;
  if (body.project_group_id !== undefined) {
    if (body.project_id !== undefined)
      throw refuseProjectGroupWith('project_id');
    const group = await authorizeProjectGroupPolicy({
      ctx,
      projectGroupPublicId: body.project_group_id,
      action,
    });
    projectGroup = {
      id: group.id as number,
      publicId: group.publicId as string,
    };
  } else if (targetsProject({ ctx, projectPublicId: body.project_id })) {
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
    await requireAdmin(ctx, action);
  }

  ctx.status = 201;
  ctx.body = throwIfInvalid(
    await createPolicy({
      name: body.name,
      description: body.description,
      document: body.document as PolicyDocument,
      project,
      projectGroup,
      writerUnrestricted: ctx.authUser.unrestricted,
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
      writerUnrestricted: ctx.authUser.unrestricted,
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
