import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { findTask, getTask } from 'src/lib/tasks';

import { requireAuth } from './helpers';
import { requireAllowed } from './resourceAccess';
import { resourcePins } from './resourcePins';

/**
 * The pins `listTasks` declares (`workflow_id`), confining every
 * `/tasks/{task_id}` route: a `builtin` tool presetting one reaches no task
 * outside it, whatever action it calls.
 */
export const taskPins = resourcePins({ listOperation: 'listTasks' });

type TaskAction =
  | 'tasks:GetTask'
  | 'tasks:UpdateTask'
  | 'tasks:DeleteTask'
  | 'tasks:TransitionTask'
  | 'tasks:MigrateTask'
  | 'tasks:PauseTask'
  | 'tasks:ResumeTask'
  | 'tasks:SetTaskPriority'
  | 'tasks:SetTaskHold'
  | 'tasks:UpdateTaskDependencies';

const taskNotFound = (id: string) => {
  return () => {
    return new DomainError('TASK_NOT_FOUND', `Task '${id}' not found.`);
  };
};

/**
 * The one entry of every by-id task route: loads the task, authorizes
 * `action` on it, and answers `404` for a task outside the call's pins.
 */
export const authorizeTask = async (args: {
  ctx: Context;
  action: TaskAction;
  id: string;
}) => {
  requireAuth(args.ctx);
  const task = await getTask({ id: args.id });
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
    notFound: taskNotFound(args.id)(),
  });
  return taskPins.assertItem({
    ctx: args.ctx,
    item: task,
    notFound: taskNotFound(args.id),
  });
};

/**
 * The other end of a dependency, held to the call's pins only: whether it
 * exists, and in which project, is the dependency lib's answer.
 */
export const assertTaskWithinPins = async (args: {
  ctx: Context;
  id: string;
}): Promise<void> => {
  if (!taskPins.isPinned(args.ctx)) return;
  taskPins.assertItem({
    ctx: args.ctx,
    item: await findTask({ id: args.id }),
    notFound: taskNotFound(args.id),
  });
};
