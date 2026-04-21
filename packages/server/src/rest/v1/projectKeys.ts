import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createProjectKey,
  getProjectKey,
  updateProjectKey,
} from 'src/lib/projectKeys';

const projectKeysRouter = new Router<Context>();

projectKeysRouter.post('/project-keys', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { projectId, policyId, name } = ctx.request.body as {
    projectId: string;
    policyId: string;
    name: string;
  };

  if (!projectId || !policyId || !name) {
    ctx.status = 400;
    ctx.body = { error: 'Missing required fields' };
    return;
  }

  // Find the project
  const project = await db.Project.findOne({
    where: { publicId: projectId },
  });

  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project' };
    return;
  }

  // Check if user is member of the project
  const membership = await db.UserProject.findOne({
    where: {
      userId: ctx.authUser.id,
      projectId: project.id,
    },
  });

  if (!membership) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // Check if policy exists and belongs to the project
  const policy = await db.ProjectPolicy.findOne({
    where: {
      publicId: policyId,
      projectId: project.id,
    },
  });

  if (!policy) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy' };
    return;
  }

  const projectKey = await createProjectKey({
    userId: ctx.authUser.id,
    projectId: project.id,
    policyId: policy.id,
    name,
  });

  ctx.status = 201;
  ctx.body = projectKey;
});

projectKeysRouter.get('/project-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectKey = await getProjectKey({ id: ctx.params.id });

  if (!projectKey) {
    ctx.status = 404;
    ctx.body = { error: 'Project key not found' };
    return;
  }

  // Check if user owns the project key
  if (projectKey.userId !== ctx.authUser.publicId) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = projectKey;
});

projectKeysRouter.put('/project-keys/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { policyId } = ctx.request.body as {
    policyId: string;
  };

  if (!policyId) {
    ctx.status = 400;
    ctx.body = { error: 'Missing policyId' };
    return;
  }

  // Find the policy
  const policy = await db.ProjectPolicy.findOne({
    where: { publicId: policyId },
  });

  if (!policy) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy' };
    return;
  }

  // Check if user owns the project key
  const projectKeyRecord = await ctx.db.ProjectKey.findOne({
    where: { publicId: ctx.params.id },
    include: [{ model: db.User }, { model: db.Project }],
  });

  if (!projectKeyRecord) {
    ctx.status = 404;
    ctx.body = { error: 'Project key not found' };
    return;
  }

  if (projectKeyRecord.userId !== ctx.authUser.id) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  // Check if policy belongs to the same project as the project key
  if (policy.projectId !== projectKeyRecord.projectId) {
    ctx.status = 400;
    ctx.body = { error: 'Policy does not belong to the same project' };
    return;
  }

  const updatedProjectKey = await updateProjectKey({
    id: ctx.params.id,
    policyId: policy.id,
  });

  ctx.body = updatedProjectKey;
});

export { projectKeysRouter };
