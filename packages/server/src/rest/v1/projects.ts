import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  addProjectMember,
  createProject,
  deleteProject,
  getProject,
  listProjectMembers,
  listProjects,
  removeProjectMember,
  updateProject,
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

projectsRouter.get('/projects', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projects = await listProjects({ authUser: ctx.authUser });
  ctx.body = projects;
});

projectsRouter.get('/projects/:project_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const result = await getProject({
    id: ctx.params.project_id,
    authUser: ctx.authUser,
  });

  ctx.body = result;
});

projectsRouter.patch('/projects/:project_id', async (ctx: Context) => {
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

  const project = await updateProject({ id: ctx.params.project_id, name });

  ctx.body = project;
});

projectsRouter.delete('/projects/:project_id', async (ctx: Context) => {
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

  await deleteProject({ id: ctx.params.project_id });

  ctx.status = 204;
});

projectsRouter.get('/projects/:project_id/members', async (ctx: Context) => {
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

  const members = await listProjectMembers({
    projectId: ctx.params.project_id,
  });

  ctx.body = members;
});

projectsRouter.post('/projects/:project_id/members', async (ctx: Context) => {
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

  const { userId } = ctx.request.body as { userId?: string };

  if (!userId || typeof userId !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'user_id is required' };
    return;
  }

  const member = await addProjectMember({
    projectId: ctx.params.project_id,
    userId,
  });

  ctx.status = 201;
  ctx.body = member;
});

projectsRouter.delete(
  '/projects/:project_id/members/:user_id',
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

    await removeProjectMember({
      projectId: ctx.params.project_id,
      userId: ctx.params.user_id,
    });

    ctx.status = 204;
  }
);

export { projectsRouter };
