import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  addTaskDependency,
  listTaskDependencies,
  removeTaskDependency,
} from 'src/lib/taskDependencies';

import { parsePagination } from './helpers';
import { authorizeTask } from './taskAccess';
import { principalFromCtx } from './tasks';

const taskDependenciesRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
taskDependenciesRouter.post(
  '/tasks/:task_id/dependencies',
  async (ctx: Context) => {
    await authorizeTask({ ctx, action: 'tasks:UpdateTaskDependencies' });
    const body = ctx.request.body as {
      depends_on_task_id: string;
      note?: string | null;
    };
    ctx.status = 201;
    ctx.body = await addTaskDependency({
      taskId: ctx.params.task_id,
      dependsOnTaskId: body.depends_on_task_id,
      note: body.note ?? null,
      principal: principalFromCtx(ctx),
    });
  }
);

taskDependenciesRouter.get(
  '/tasks/:task_id/dependencies',
  async (ctx: Context) => {
    await authorizeTask({ ctx, action: 'tasks:GetTask' });
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
    await authorizeTask({ ctx, action: 'tasks:GetTask' });
    ctx.body = await listTaskDependencies({
      taskId: ctx.params.task_id,
      direction: 'dependents',
      ...parsePagination(ctx),
    });
  }
);

taskDependenciesRouter.delete(
  '/tasks/:task_id/dependencies/:dependency_id',
  async (ctx: Context) => {
    await authorizeTask({ ctx, action: 'tasks:UpdateTaskDependencies' });
    await removeTaskDependency({
      taskId: ctx.params.task_id,
      dependencyId: ctx.params.dependency_id,
      principal: principalFromCtx(ctx),
    });
    ctx.status = 204;
  }
);

export { taskDependenciesRouter };
