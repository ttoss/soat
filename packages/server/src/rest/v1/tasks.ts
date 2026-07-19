import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createTask,
  deleteTask,
  getTask,
  getTaskHistory,
  listTasks,
  type TaskActor,
  transitionTask,
  updateTask,
} from 'src/lib/tasks';

import {
  checkAuth,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';

const tasksRouter = new Router<Context>();

/**
 * Builds the transition actor from the authenticated principal. For API-key
 * auth the actor id is the key's own public id (`key_...`) so history can
 * distinguish which key acted — not just that *a* key did — falling back to the
 * user id only if the key id is somehow absent. `apiKeyPublicId` is set for
 * both scoped and unscoped keys, so it (not `apiKeyProjectId`) determines the
 * `api_key` kind.
 */
const actorFromCtx = (ctx: Context): TaskActor => {
  const apiKeyPublicId = ctx.authUser!.apiKeyPublicId;
  if (apiKeyPublicId) {
    return { kind: 'api_key', id: apiKeyPublicId };
  }
  return { kind: 'user', id: ctx.authUser!.publicId };
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
tasksRouter.get('/tasks', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const projectPublicId = ctx.query.projectId as string | undefined;
  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'tasks:ListTasks',
  });
  if (projectIds === null) return;

  ctx.body = await listTasks({
    projectIds: projectIds ?? [],
    workflowId: ctx.query.workflowId as string | undefined,
    state: ctx.query.state as string | undefined,
    status: ctx.query.status as string | undefined,
    assignee: ctx.query.assignee as string | undefined,
  });
});

tasksRouter.get('/tasks/:task_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.projectId!,
    action: 'tasks:GetTask',
    resource: `soat:${task.projectId}:*:*`,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = task;
});

tasksRouter.get('/tasks/:task_id/history', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.projectId!,
    action: 'tasks:GetTask',
    resource: `soat:${task.projectId}:*:*`,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await getTaskHistory({ id: ctx.params.task_id });
});

tasksRouter.post('/tasks', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    workflowId: string;
    title: string;
    payload?: Record<string, unknown> | null;
    assignee?: string | null;
  };

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'tasks:CreateTask',
  });
  if (projectId === null) return;

  const task = await createTask({
    projectId,
    workflowId: body.workflowId,
    title: body.title,
    payload: body.payload,
    assignee: body.assignee,
    actor: actorFromCtx(ctx),
  });

  ctx.status = 201;
  ctx.body = task;
});

tasksRouter.patch('/tasks/:task_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.projectId!,
    action: 'tasks:UpdateTask',
    resource: `soat:${task.projectId}:*:*`,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    title?: string;
    payload?: Record<string, unknown>;
    assignee?: string | null;
  };

  ctx.body = await updateTask({
    id: ctx.params.task_id,
    title: body.title,
    payload: body.payload,
    assignee: body.assignee,
  });
});

tasksRouter.post('/tasks/:task_id/transitions', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.projectId!,
    action: 'tasks:TransitionTask',
    resource: `soat:${task.projectId}:*:*`,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    transition: string;
    note?: string | null;
  };

  ctx.body = await transitionTask({
    id: ctx.params.task_id,
    transition: body.transition,
    note: body.note,
    actor: actorFromCtx(ctx),
  });
});

tasksRouter.delete('/tasks/:task_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.projectId!,
    action: 'tasks:DeleteTask',
    resource: `soat:${task.projectId}:*:*`,
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteTask({ id: ctx.params.task_id });
  ctx.status = 204;
});

export { tasksRouter };
