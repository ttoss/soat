import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';
import { db } from 'src/db';

import { appendDependencyHistory, emitUnblocked } from './taskDependencies';
import { freedAmong } from './taskReadiness';
import type { TaskPrincipal } from './tasks';

const log = createDebug('soat:tasks');

/**
 * Deletes the task and, by cascade, its edges: each surviving end gets a
 * `dependency_removed` row, and a dependent it was the last open blocker of
 * is freed.
 */
export const deleteTask = async (args: {
  id: string;
  principal: TaskPrincipal;
}) => {
  log('deleteTask: id=%s', args.id);
  const task = await db.Task.findOne({
    where: { publicId: args.id },
    rejectOnEmpty: true,
  });
  const freed = await db.sequelize.transaction(async (t) => {
    const edges = await db.TaskDependency.findAll({
      where: {
        [Op.or]: [{ taskId: task.id as number }, { dependsOnTaskId: task.id }],
      },
      include: [
        { model: db.Task, as: 'task' },
        { model: db.Task, as: 'dependsOnTask' },
      ],
      transaction: t,
    });
    const survivors = edges.map((edge) => {
      return edge.taskId === task.id ? edge.dependsOnTask : edge.task;
    });
    await task.destroy({ transaction: t });
    await appendDependencyHistory({
      kind: 'dependency_removed',
      ends: survivors.map((survivor) => {
        return { task: survivor, related: task };
      }),
      principal: args.principal,
      transaction: t,
    });
    if (task.status !== 'open') return [];
    return freedAmong({
      candidateIds: edges
        .filter((edge) => {
          return edge.dependsOnTaskId === task.id;
        })
        .map((edge) => {
          return edge.taskId;
        }),
      transaction: t,
    });
  });
  await emitUnblocked({ taskIds: freed, projectId: task.projectId as number });
};
