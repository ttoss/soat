import createDebug from 'debug';
import { db } from 'src/db';
import { DomainError } from 'src/errors';

import { pageReader, type TaskListFilters, taskListWhere } from './tasksList';

const log = createDebug('soat:tasks');

/** How many tasks one graph answers before it is refused. */
const DEFAULT_GRAPH_LIMIT = 500;

const graphLimit = (): number => {
  const configured = Number(process.env.TASK_GRAPH_LIMIT);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_GRAPH_LIMIT;
};

/**
 * The tasks `listTasks` would select with the same filters, and the
 * dependencies between them. Answered whole: a graph cut into pages would show
 * a held task as free, so above the ceiling it is refused, never truncated.
 */
export const getTaskGraph = async (args: TaskListFilters) => {
  log(
    'getTaskGraph: projectIds=%o workflowId=%s upstreamOf=%s',
    args.projectIds,
    args.workflowId,
    args.upstreamOf
  );
  const where = await taskListWhere(args);
  const limit = graphLimit();
  const count = await db.Task.count({ where });
  if (count > limit) {
    throw new DomainError(
      'TASK_GRAPH_TOO_LARGE',
      `The graph holds ${count} tasks, above the limit of ${limit}. Narrow it with a filter such as upstream_of or status.`,
      { count, limit }
    );
  }

  const { read, map } = pageReader();
  const rows = await read({
    where,
    limit,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const publicIds = new Map(
    rows.map((row) => {
      return [row.id as number, row.publicId];
    })
  );
  const ids = [...publicIds.keys()];
  const dependencies =
    ids.length === 0
      ? []
      : await db.TaskDependency.findAll({
          where: { taskId: ids, dependsOnTaskId: ids },
          attributes: ['taskId', 'dependsOnTaskId'],
          order: [['id', 'ASC']],
        });

  return {
    nodes: rows.map(map),
    edges: dependencies.map((dependency) => {
      return {
        task_id: publicIds.get(dependency.taskId as number)!,
        depends_on_task_id: publicIds.get(
          dependency.dependsOnTaskId as number
        )!,
      };
    }),
  };
};
