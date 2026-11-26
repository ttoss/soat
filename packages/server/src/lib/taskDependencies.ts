import createDebug from 'debug';
import { db } from 'src/db';

import { DomainError } from '../errors';
import { lockForTransaction } from './advisoryLocks';
import type { Transaction } from './dbTransaction';
import { paginatedList } from './pagination';
import { createdByColumns, servedPrincipal } from './principals';
import { emitTaskEvent } from './taskEvents';
import { freedAmong } from './taskReadiness';
import {
  findTaskInstance,
  presentTask,
  recordedTaskPrincipal,
  taskIncludes,
  type TaskInstance,
  type TaskPrincipal,
} from './tasks';

const log = createDebug('soat:tasks');

type TaskRow = InstanceType<(typeof db)['Task']>;
type DependencyRow = InstanceType<(typeof db)['TaskDependency']> & {
  task?: TaskRow;
  dependsOnTask?: TaskRow;
};

const taskRef = (task: TaskRow) => {
  return {
    id: task.publicId,
    title: task.title,
    state: task.state,
    status: task.status,
  };
};

const mapDependency = (row: DependencyRow) => {
  return {
    task: taskRef(row.task!),
    depends_on_task: taskRef(row.dependsOnTask!),
    note: row.note,
    ...servedPrincipal({
      row,
      prefix: 'createdBy',
      wire: 'created_by_',
    }),
    created_at: row.createdAt,
  };
};

const dependencyIncludes = () => {
  return [
    { model: db.Task, as: 'task' },
    { model: db.Task, as: 'dependsOnTask' },
  ];
};

const requireTask = async (args: { id: string }): Promise<TaskInstance> => {
  const task = await findTaskInstance({ id: args.id });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  return task;
};

/** Emits `tasks.unblocked` for each task a committed write freed. */
export const emitUnblocked = async (args: {
  taskIds: number[];
  projectId: number;
  unblockedBy: { task_id: string; state: string };
}): Promise<void> => {
  for (const id of args.taskIds) {
    const task = (await db.Task.findByPk(id, {
      include: taskIncludes(),
    })) as TaskInstance | null;
    if (!task) continue;
    await emitTaskEvent({
      type: 'tasks.unblocked',
      projectId: args.projectId,
      task: await presentTask({ task }),
      facts: { unblocked_by: args.unblockedBy },
    });
  }
};

/**
 * The task ids from `dependsOn` back to `task` through existing edges, when
 * adding `task → dependsOn` would close a cycle; else null.
 */
const cyclePath = async (args: {
  task: TaskRow;
  dependsOn: TaskRow;
  transaction: Transaction;
}): Promise<string[] | null> => {
  const [rows] = await db.sequelize.query(
    `WITH RECURSIVE reach(id, path) AS (
       SELECT CAST(:from AS integer), ARRAY[CAST(:from AS integer)]
       UNION ALL
       SELECT d.depends_on_task_id, r.path || d.depends_on_task_id
         FROM reach r
         JOIN task_dependencies d ON d.task_id = r.id
        WHERE NOT d.depends_on_task_id = ANY(r.path)
     )
     SELECT path FROM reach WHERE id = :target LIMIT 1`,
    {
      replacements: {
        from: args.dependsOn.id as number,
        target: args.task.id as number,
      },
      transaction: args.transaction,
    }
  );
  const found = (rows as { path: number[] }[])[0];
  if (!found) return null;
  const tasks = await db.Task.findAll({
    where: { id: found.path },
    attributes: ['id', 'publicId'],
    transaction: args.transaction,
  });
  const publicIds = new Map(
    tasks.map((t) => {
      return [t.id as number, t.publicId];
    })
  );
  return [
    args.task.publicId,
    ...found.path.map((id) => {
      return publicIds.get(id)!;
    }),
  ];
};

/**
 * `created` is false when the pair already held: the existing edge answers,
 * unchanged.
 */
export const addTaskDependency = async (args: {
  taskId: string;
  dependsOnTaskId: string;
  note?: string | null;
  principal: TaskPrincipal;
}) => {
  log(
    'addTaskDependency: task=%s dependsOn=%s',
    args.taskId,
    args.dependsOnTaskId
  );
  const task = await requireTask({ id: args.taskId });
  if (args.dependsOnTaskId === args.taskId) {
    throw new DomainError(
      'TASK_DEPENDENCY_SELF',
      `Task '${args.taskId}' cannot depend on itself.`
    );
  }
  const dependsOn = await db.Task.findOne({
    where: { publicId: args.dependsOnTaskId, projectId: task.projectId },
  });
  if (!dependsOn) {
    throw new DomainError(
      'TASK_DEPENDENCY_TARGET_NOT_FOUND',
      `Task '${args.dependsOnTaskId}' not found in the project of '${args.taskId}'.`,
      { depends_on_task_id: args.dependsOnTaskId }
    );
  }

  const { id, created } = await db.sequelize.transaction(async (t) => {
    // One writer per project's graph at a time, so two edges added at once
    // cannot close a cycle neither sees.
    await lockForTransaction({
      sequelize: db.sequelize,
      transaction: t,
      namespace: 'taskDependencyGraph',
      id: task.projectId as number,
    });
    const existing = await db.TaskDependency.findOne({
      where: { taskId: task.id as number, dependsOnTaskId: dependsOn.id },
      transaction: t,
    });
    if (existing) {
      log('addTaskDependency: edge exists');
      return { id: existing.id as number, created: false };
    }
    if (task.status !== 'open') {
      throw new DomainError(
        'TASK_DEPENDENCY_CLOSED',
        `Task '${args.taskId}' is closed.`
      );
    }
    const path = await cyclePath({ task, dependsOn, transaction: t });
    if (path) {
      throw new DomainError(
        'TASK_DEPENDENCY_CYCLE',
        `Task '${args.dependsOnTaskId}' already depends on '${args.taskId}'.`,
        { path }
      );
    }
    const row = await db.TaskDependency.create(
      {
        taskId: task.id as number,
        dependsOnTaskId: dependsOn.id as number,
        note: args.note ?? null,
        ...createdByColumns(recordedTaskPrincipal(args.principal)),
      },
      { transaction: t }
    );
    return { id: row.id as number, created: true };
  });

  const row = await db.TaskDependency.findByPk(id, {
    include: dependencyIncludes(),
  });
  return { dependency: mapDependency(row as DependencyRow), created };
};

export const listTaskDependencies = async (args: {
  taskId: string;
  direction: 'dependencies' | 'dependents';
  limit?: number;
  cursor?: string;
}) => {
  log('listTaskDependencies: task=%s %s', args.taskId, args.direction);
  const task = await requireTask({ id: args.taskId });
  const column =
    args.direction === 'dependencies' ? 'taskId' : 'dependsOnTaskId';
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { id: args.taskId, direction: args.direction },
    where: { [column]: task.id as number },
    order: [['createdAt', 'ASC']],
    // An edge's identity is its pair; the internal id only orders the page.
    tiebreak: ['id'],
    query: ({ where, limit, order }) => {
      return db.TaskDependency.findAll({
        where,
        limit,
        order,
        include: dependencyIncludes(),
      });
    },
    map: (row) => {
      return mapDependency(row as DependencyRow);
    },
  });
};

/** Idempotent: an edge already gone, or a task it named, removes nothing. */
export const removeTaskDependency = async (args: {
  taskId: string;
  dependsOnTaskId: string;
}): Promise<void> => {
  log(
    'removeTaskDependency: task=%s dependsOn=%s',
    args.taskId,
    args.dependsOnTaskId
  );
  const task = await requireTask({ id: args.taskId });
  const removed = await db.sequelize.transaction(async (t) => {
    const row = (await db.TaskDependency.findOne({
      where: { taskId: task.id as number },
      include: [
        {
          model: db.Task,
          as: 'dependsOnTask',
          where: { publicId: args.dependsOnTaskId },
        },
      ],
      transaction: t,
    })) as DependencyRow | null;
    if (!row) {
      log('removeTaskDependency: no edge');
      return null;
    }
    const dependsOn = row.dependsOnTask!;
    await row.destroy({ transaction: t });
    // A closed dependency held nothing, so removing it frees nothing.
    if (dependsOn.status !== 'open') return null;
    const freed = await freedAmong({
      candidateIds: [task.id as number],
      transaction: t,
    });
    return { freed, dependsOn };
  });
  if (!removed) return;
  await emitUnblocked({
    taskIds: removed.freed,
    projectId: task.projectId as number,
    unblockedBy: {
      task_id: removed.dependsOn.publicId,
      state: removed.dependsOn.state,
    },
  });
};
