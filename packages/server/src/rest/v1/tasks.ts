import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import { principalFromAuthUser } from 'src/lib/principals';
import {
  createTask,
  deleteTask,
  getTask,
  getTaskHistory,
  listTasks,
  type TaskPrincipal,
  transitionTask,
  updateTask,
} from 'src/lib/tasks';

import {
  checkAuth,
  parsePagination,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';

const tasksRouter = new Router<Context>();

/**
 * The transition principal for the authenticated caller, in the task engine's
 * own `{ kind, id }` shape.
 *
 * `TaskPrincipal` carries two kinds the auth layer has no notion of
 * (`automation`, `approval`), so the shapes stay distinct — but the *rule* for
 * the two credential-derived kinds is shared with audit and the REST helper, so
 * a key-started background drive is named identically in task history and in the
 * audit log.
 */
const principalFromCtx = (ctx: Context): TaskPrincipal => {
  const { principalType, principalId } = principalFromAuthUser(ctx.authUser!);
  return { kind: principalType, id: principalId };
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
tasksRouter.get('/tasks', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const projectPublicId = ctx.query.project_id as string | undefined;
  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'tasks:ListTasks',
    resourceType: 'task',
  });
  if (projectIds === null) return;

  ctx.body = await listTasks({
    projectIds: projectIds ?? [],
    workflowId: ctx.query.workflow_id as string | undefined,
    state: ctx.query.state as string | undefined,
    status: ctx.query.status as string | undefined,
    assignee: ctx.query.assignee as string | undefined,
    ...parsePagination(ctx),
  });
});

tasksRouter.get('/tasks/:task_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.project_id!,
    action: 'tasks:GetTask',
    resource: buildSrn({
      projectPublicId: task.project_id!,
      resourceType: 'task',
      resourceId: task.id,
    }),
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
    projectPublicId: task.project_id!,
    action: 'tasks:GetTask',
    resource: buildSrn({
      projectPublicId: task.project_id!,
      resourceType: 'task',
      resourceId: task.id,
    }),
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
    project_id?: string;
    workflow_id: string;
    title: string;
    payload?: Record<string, unknown> | null;
    assignee?: string | null;
    state?: string | null;
  };

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'tasks:CreateTask',
    resourceType: 'task',
  });
  if (projectId === null) return;

  const task = await createTask({
    projectId,
    workflowId: body.workflow_id,
    title: body.title,
    payload: body.payload,
    assignee: body.assignee,
    state: body.state,
    principal: principalFromCtx(ctx),
  });

  ctx.status = 201;
  ctx.body = task;
});

tasksRouter.patch('/tasks/:task_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.project_id!,
    action: 'tasks:UpdateTask',
    resource: buildSrn({
      projectPublicId: task.project_id!,
      resourceType: 'task',
      resourceId: task.id,
    }),
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
    projectPublicId: task.project_id!,
    action: 'tasks:TransitionTask',
    resource: buildSrn({
      projectPublicId: task.project_id!,
      resourceType: 'task',
      resourceId: task.id,
    }),
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
    principal: principalFromCtx(ctx),
    // A run-as token names a user or key like any other credential, so the
    // principal above cannot distinguish a dispatch continuing its own chain
    // from the person who started it. This can (#885).
    viaRunToken: ctx.authUser!.isRunToken === true,
  });
});

tasksRouter.delete('/tasks/:task_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const task = await getTask({ id: ctx.params.task_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: task.project_id!,
    action: 'tasks:DeleteTask',
    resource: buildSrn({
      projectPublicId: task.project_id!,
      resourceType: 'task',
      resourceId: task.id,
    }),
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
