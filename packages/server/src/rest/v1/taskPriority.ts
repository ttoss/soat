import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { parseTaskPriority, setTaskPriority } from 'src/lib/tasksPriority';

import { authorizeTask } from './taskAccess';

const taskPriorityRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
taskPriorityRouter.put('/tasks/:task_id/priority', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:SetTaskPriority',
    id: ctx.params.task_id,
  });

  const body = ctx.request.body as { priority?: unknown };

  ctx.body = await setTaskPriority({
    id: ctx.params.task_id,
    priority: parseTaskPriority(body.priority),
  });
});

export { taskPriorityRouter };
