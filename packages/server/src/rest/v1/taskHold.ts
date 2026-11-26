import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { parseTaskHold, setTaskHold } from 'src/lib/tasksHold';

import { authorizeTask } from './taskAccess';

const taskHoldRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
taskHoldRouter.put('/tasks/:task_id/hold', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:SetTaskHold',
    id: ctx.params.task_id,
  });

  const body = ctx.request.body as {
    hold_until?: unknown;
    hold_reason?: unknown;
  };

  ctx.body = await setTaskHold({
    id: ctx.params.task_id,
    hold: parseTaskHold({ until: body.hold_until, reason: body.hold_reason }),
  });
});

export { taskHoldRouter };
