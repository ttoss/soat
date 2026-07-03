import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
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

  const force = ctx.query.force === 'true';

  await deleteProject({ id: ctx.params.project_id, force });

  ctx.status = 204;
});

export { projectsRouter };
