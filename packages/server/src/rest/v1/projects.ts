import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import type { PolicyDocument } from 'src/lib/iam';
import {
  addUserToProject,
  createProject,
  createProjectPolicy,
  deleteProject,
  deleteProjectPolicy,
  getProject,
  getProjectPolicy,
  getUserProjectPolicies,
  listProjectPolicies,
  listProjects,
  updateProjectPolicy,
  updateUserProjectPolicies,
} from 'src/lib/projects';

const projectsRouter = new Router<Context>();

projectsRouter.post('/projects', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { name } = ctx.request.body as { name?: string };

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const project = await createProject({ name });

  ctx.status = 201;
  ctx.body = project;
});

projectsRouter.get('/projects/:projectId/policies', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  // Check if user is member of the project
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: ctx.params.projectId,
    action: 'projects:GetProject',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const policies = await listProjectPolicies({
    projectId: ctx.params.projectId,
  });

  ctx.body = policies;
});

projectsRouter.post('/projects/:projectId/policies', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { name, description, permissions, notPermissions } = ctx.request
    .body as {
    name?: string;
    description?: string;
    permissions: string[];
    notPermissions?: string[];
  };

  const document: PolicyDocument = {
    statement: [
      ...(permissions?.length
        ? [{ effect: 'Allow' as const, action: permissions }]
        : []),
      ...(notPermissions?.length
        ? [{ effect: 'Deny' as const, action: notPermissions }]
        : []),
    ],
  };

  const result = await createProjectPolicy({
    projectId: ctx.params.projectId,
    name,
    description,
    document,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  if ('invalid' in result) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy document', details: result.errors };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

projectsRouter.put(
  '/projects/:projectId/policies/:policyId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    if (ctx.authUser.role !== 'admin') {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const { name, description, document } = ctx.request.body as {
      name?: string;
      description?: string;
      document: object;
    };

    const result = await updateProjectPolicy({
      projectId: ctx.params.projectId,
      policyId: ctx.params.policyId,
      name,
      description,
      document: document as PolicyDocument,
    });

    if (result === 'not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Project or policy not found' };
      return;
    }

    if ('invalid' in result) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid policy document', details: result.errors };
      return;
    }

    ctx.body = result;
  }
);

projectsRouter.delete(
  '/projects/:projectId/policies/:policyId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    if (ctx.authUser.role !== 'admin') {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const result = await deleteProjectPolicy({
      projectId: ctx.params.projectId,
      policyId: ctx.params.policyId,
    });

    if (result === 'not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Project or policy not found' };
      return;
    }

    ctx.status = 204;
  }
);

projectsRouter.get(
  '/projects/:projectId/policies/:policyId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'projects:GetProject',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const policy = await getProjectPolicy({
      projectId: ctx.params.projectId,
      policyId: ctx.params.policyId,
    });

    if (!policy) {
      ctx.status = 404;
      ctx.body = { error: 'Policy not found' };
      return;
    }

    ctx.body = policy;
  }
);

projectsRouter.post('/projects/:projectId/members', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { userId, policyId, policyIds } = ctx.request.body as {
    userId: string;
    policyId?: string;
    policyIds?: string[];
  };

  const resolvedPolicyIds = policyIds ?? (policyId ? [policyId] : undefined);

  const success = await addUserToProject({
    projectId: ctx.params.projectId,
    userId,
    policyIds: resolvedPolicyIds,
  });

  if (!success) {
    ctx.status = 404;
    ctx.body = { error: 'Project, user, or policy not found' };
    return;
  }

  ctx.status = 201;
});

projectsRouter.put(
  '/projects/:projectId/members/:userId/policies',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    if (ctx.authUser.role !== 'admin') {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const { policyIds } = ctx.request.body as { policyIds: string[] };

    const result = await updateUserProjectPolicies({
      projectId: ctx.params.projectId,
      userId: ctx.params.userId,
      policyIds,
    });

    if (result === 'not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Project, user, membership, or policy not found' };
      return;
    }

    ctx.status = 204;
  }
);

projectsRouter.get(
  '/projects/:projectId/members/:userId/policies',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    if (ctx.authUser.role !== 'admin') {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const policies = await getUserProjectPolicies({
      projectId: ctx.params.projectId,
      userId: ctx.params.userId,
    });

    if (policies === null) {
      ctx.status = 404;
      ctx.body = { error: 'Project or user not found' };
      return;
    }

    ctx.body = policies;
  }
);

projectsRouter.get('/projects', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projects = await listProjects({ authUser: ctx.authUser });
  ctx.body = projects;
});

projectsRouter.get('/projects/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const result = await getProject({
    id: ctx.params.id,
    authUser: ctx.authUser,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  if (result === 'forbidden') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = result;
});

projectsRouter.delete('/projects/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const result = await deleteProject({ id: ctx.params.id });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  ctx.status = 204;
});

export { projectsRouter };
