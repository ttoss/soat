import { db } from 'src/db';

import { unblocksSql } from './taskReadiness';
import { TASK_PRIORITIES } from './tasksPriority';

type Literal = ReturnType<typeof db.sequelize.literal>;

/** The orders `listTasks` takes besides newest first. */
export const TASK_LIST_ORDERS = ['next'] as const;

export type TaskListOrder = (typeof TASK_LIST_ORDERS)[number];

/** A priority as a number, higher first; `null` ranks below every value. */
const rankSql = (column: string): string => {
  const cases = TASK_PRIORITIES.map((priority, index) => {
    return `WHEN '${priority}' THEN ${TASK_PRIORITIES.length - index}`;
  });
  return `CASE ${column} ${cases.join(' ')} ELSE 0 END`;
};

/**
 * The highest own priority of the task and of every open task it holds,
 * transitively, over the list's `Task` alias. `UNION` keeps a shared
 * dependent from being walked twice.
 */
const effectivePrioritySql = (): string => {
  return `(WITH RECURSIVE held(id) AS (
      SELECT "Task"."id"
      UNION
      SELECT d.task_id FROM task_dependencies d
        JOIN held h ON d.depends_on_task_id = h.id
        JOIN tasks t ON t.id = d.task_id
       WHERE t.status = 'open')
    SELECT MAX(${rankSql('p.priority')}) FROM held JOIN tasks p ON p.id = held.id)`;
};

/**
 * Pull order: effective priority, then `readiness.unblocks`, then the oldest
 * `entered_state_at`, then `id`. Computed per read, so no cursor resumes it.
 */
export const pullOrder = (): [Literal | string, 'ASC' | 'DESC'][] => {
  return [
    [db.sequelize.literal(effectivePrioritySql()), 'DESC'],
    [db.sequelize.literal(unblocksSql()), 'DESC'],
    ['enteredStateAt', 'ASC'],
    ['publicId', 'ASC'],
  ];
};
