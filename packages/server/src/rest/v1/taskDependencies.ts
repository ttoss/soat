import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  addTaskDependency,
  listTaskDependencies,
  removeTaskDependency,
} from 'src/lib/taskDependencies';

import { parsePagination } from './helpers';
import { assertTaskWithinPins, authorizeTask } from './taskAccess';
import { principalFromCtx } from './tasks';

const taskDependenciesRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
taskDependenciesRouter.post(
  '/tasks/:task_id/dependencies',
  async (ctx: Context) => {
    await authorizeTask({
      ctx,
      action: 'tasks:UpdateTaskDependencies',
      id: ctx.params.task_id,
    });
    const body = ctx.request.body as {
      depends_on_task_id: string;
      note?: string | null;
    };
    await assertTaskWithinPins({ ctx, id: body.depends_on_task_id });
    const { dependency, created } = await addTaskDependency({
      taskId: ctx.params.task_id,
      dependsOnTaskId: body.depends_on_task_id,
      note: body.note ?? null,
      principal: principalFromCtx(ctx),
    });
    ctx.status = created ? 201 : 200;
    ctx.body = dependency;
  }
);

taskDependenciesRouter.get(
  '/tasks/:task_id/dependencies',
  async (ctx: Context) => {
    await authorizeTask({
      ctx,
      action: 'tasks:GetTask',
      id: ctx.params.task_id,
    });
    ctx.body = await listTaskDependencies({
      taskId: ctx.params.task_id,
      direction: 'dependencies',
      ...parsePagination(ctx),
    });
  }
);

taskDependenciesRouter.get(
  '/tasks/:task_id/dependents',
  async (ctx: Context) => {
    await authorizeTask({
      ctx,
      action: 'tasks:GetTask',
      id: ctx.params.task_id,
    });
    ctx.body = await listTaskDependencies({
      taskId: ctx.params.task_id,
      direction: 'dependents',
      ...parsePagination(ctx),
    });
  }
);

taskDependenciesRouter.delete(
  '/tasks/:task_id/dependencies/:depends_on_task_id',
  async (ctx: Context) => {
    await authorizeTask({
      ctx,
      action: 'tasks:UpdateTaskDependencies',
      id: ctx.params.task_id,
    });
    await assertTaskWithinPins({ ctx, id: ctx.params.depends_on_task_id });
    await removeTaskDependency({
      taskId: ctx.params.task_id,
      dependsOnTaskId: ctx.params.depends_on_task_id,
    });
    ctx.status = 204;
  }
);

export { taskDependenciesRouter };
