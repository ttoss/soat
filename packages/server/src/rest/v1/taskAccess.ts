import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { getTask } from 'src/lib/tasks';

import { requireAuth } from './helpers';
import { requireAllowed } from './resourceAccess';

/**
 * The path's task, once the caller may take `action` on it; a task the caller
 * may not see is `404`, like one that does not exist.
 */
export const authorizeTask = async (args: {
  ctx: Context;
  action: `tasks:${string}`;
}) => {
  requireAuth(args.ctx);
  const task = await getTask({ id: args.ctx.params.task_id });
  await requireAllowed({
    ctx: args.ctx,
    check: {
      projectPublicId: task.project_id!,
      action: args.action,
      resource: buildSrn({
        projectPublicId: task.project_id!,
        resourceType: 'task',
        resourceId: task.id,
      }),
    },
    notFound: new DomainError(
      'TASK_NOT_FOUND',
      `Task '${args.ctx.params.task_id}' not found.`
    ),
  });
  return task;
};
