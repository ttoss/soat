import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { addTaskLink, listTaskLinks, removeTaskLink } from 'src/lib/taskLinks';

import { parseEnumQuery, parsePagination } from './helpers';
import { assertTaskWithinPins, authorizeTask } from './taskAccess';
import { principalFromCtx } from './tasks';

const taskLinksRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
taskLinksRouter.post('/tasks/:task_id/links', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:UpdateTaskLinks',
    id: ctx.params.task_id,
  });
  const body = ctx.request.body as {
    to_task_id: string;
    kind: string;
    note?: string | null;
  };
  await assertTaskWithinPins({ ctx, id: body.to_task_id });
  const { link, created } = await addTaskLink({
    taskId: ctx.params.task_id,
    toTaskId: body.to_task_id,
    kind: body.kind,
    note: body.note ?? null,
    principal: principalFromCtx(ctx),
  });
  ctx.status = created ? 201 : 200;
  ctx.body = link;
});

taskLinksRouter.get('/tasks/:task_id/links', async (ctx: Context) => {
  await authorizeTask({ ctx, action: 'tasks:GetTask', id: ctx.params.task_id });
  ctx.body = await listTaskLinks({
    taskId: ctx.params.task_id,
    direction: parseEnumQuery({
      ctx,
      name: 'direction',
      allowed: ['out', 'in'] as const,
    }),
    kind: ctx.query.kind as string | undefined,
    ...parsePagination(ctx),
  });
});

taskLinksRouter.delete(
  '/tasks/:task_id/links/:kind/:to_task_id',
  async (ctx: Context) => {
    await authorizeTask({
      ctx,
      action: 'tasks:UpdateTaskLinks',
      id: ctx.params.task_id,
    });
    await assertTaskWithinPins({ ctx, id: ctx.params.to_task_id });
    await removeTaskLink({
      taskId: ctx.params.task_id,
      toTaskId: ctx.params.to_task_id,
      kind: ctx.params.kind,
      principal: principalFromCtx(ctx),
    });
    ctx.status = 204;
  }
);

export { taskLinksRouter };
