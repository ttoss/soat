import createDebug from 'debug';
import { db } from 'src/db';

import { emitUnblocked } from './taskDependencies';
import { freedAmong } from './taskReadiness';

const log = createDebug('soat:tasks');

/**
 * Deletes the task and, by cascade, its edges; a dependent it was the last
 * open blocker of is freed.
 */
export const deleteTask = async (args: { id: string }) => {
  log('deleteTask: id=%s', args.id);
  const task = await db.Task.findOne({
    where: { publicId: args.id },
    rejectOnEmpty: true,
  });
  const freed = await db.sequelize.transaction(async (t) => {
    const dependents = await db.TaskDependency.findAll({
      where: { dependsOnTaskId: task.id as number },
      attributes: ['taskId'],
      transaction: t,
    });
    await task.destroy({ transaction: t });
    if (task.status !== 'open') return [];
    return freedAmong({
      candidateIds: dependents.map((edge) => {
        return edge.taskId;
      }),
      transaction: t,
    });
  });
  await emitUnblocked({
    taskIds: freed,
    projectId: task.projectId as number,
    unblockedBy: { task_id: task.publicId, state: task.state },
  });
};
