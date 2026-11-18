import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { getTask } from 'src/lib/tasks';
import { parseTaskPriority, setTaskPriority } from 'src/lib/tasksPriority';

import { requireAuth } from './helpers';
import { requireAllowed } from './resourceAccess';

const taskPriorityRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
taskPriorityRouter.put('/tasks/:task_id/priority', async (ctx: Context) => {
  requireAuth(ctx);
  const task = await getTask({ id: ctx.params.task_id });

  await requireAllowed({
    ctx,
    check: {
      projectPublicId: task.project_id!,
      action: 'tasks:SetTaskPriority',
      resource: buildSrn({
        projectPublicId: task.project_id!,
        resourceType: 'task',
        resourceId: task.id,
      }),
    },
    notFound: new DomainError(
      'TASK_NOT_FOUND',
      `Task '${ctx.params.task_id}' not found.`
    ),
  });

  const body = ctx.request.body as { priority?: unknown };

  ctx.body = await setTaskPriority({
    id: ctx.params.task_id,
    priority: parseTaskPriority(body.priority),
  });
});

export { taskPriorityRouter };
