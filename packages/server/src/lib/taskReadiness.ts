import { db } from 'src/db';

import type { Transaction } from './dbTransaction';

export const BLOCKED_BY_LIMIT = 20;

export type TaskBlocker =
  | { kind: 'scheduled'; until: Date; reason: string | null }
  | { kind: 'task'; task_id: string; title: string; state: string };

export type TaskReadiness = {
  blocked: boolean;
  blocked_by: TaskBlocker[];
  blocked_by_count: number;
  unblocks: number;
};

type HoldRow = { id: number; hold_until: Date; hold_reason: string | null };

/**
 * A hold blocks while its date is ahead of the database clock. `COALESCE`, so
 * a task holding nothing is `FALSE`, never `NULL`, under a `NOT`.
 */
const HOLD_ACTIVE_SQL = (alias: string) => {
  return `COALESCE(${alias}.hold_until > NOW(), FALSE)`;
};

type BlockerRow = {
  task_id: number;
  public_id: string;
  title: string;
  state: string;
};

type CountRow = { id: number; count: string };

/**
 * Readiness of each task in `taskIds` as it stands now: a hold whose date is
 * ahead blocks, listed first, as does each open dependency; only an open
 * dependent counts as held.
 */
export const readinessOf = async (args: {
  taskIds: number[];
  transaction?: Transaction;
}): Promise<Map<number, TaskReadiness>> => {
  const result = new Map<number, TaskReadiness>();
  for (const id of args.taskIds) {
    result.set(id, {
      blocked: false,
      blocked_by: [],
      blocked_by_count: 0,
      unblocks: 0,
    });
  }
  if (args.taskIds.length === 0) return result;

  const [holds] = await db.sequelize.query(
    `SELECT t.id, t.hold_until, t.hold_reason FROM tasks t
      WHERE t.id IN (:ids) AND ${HOLD_ACTIVE_SQL('t')}`,
    { replacements: { ids: args.taskIds }, transaction: args.transaction }
  );
  for (const row of holds as HoldRow[]) {
    const readiness = result.get(row.id)!;
    readiness.blocked = true;
    readiness.blocked_by_count += 1;
    readiness.blocked_by.push({
      kind: 'scheduled',
      until: new Date(row.hold_until),
      reason: row.hold_reason,
    });
  }

  const [blockers] = await db.sequelize.query(
    `SELECT d.task_id, b.public_id, b.title, b.state
       FROM task_dependencies d
       JOIN tasks b ON b.id = d.depends_on_task_id
      WHERE d.task_id IN (:ids) AND b.status = 'open'
      ORDER BY d.created_at ASC, d.id ASC`,
    { replacements: { ids: args.taskIds }, transaction: args.transaction }
  );
  for (const row of blockers as BlockerRow[]) {
    const readiness = result.get(row.task_id)!;
    readiness.blocked = true;
    readiness.blocked_by_count += 1;
    if (readiness.blocked_by.length < BLOCKED_BY_LIMIT) {
      readiness.blocked_by.push({
        kind: 'task',
        task_id: row.public_id,
        title: row.title,
        state: row.state,
      });
    }
  }

  const [held] = await db.sequelize.query(
    `SELECT d.depends_on_task_id AS id, COUNT(*) AS count
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
      WHERE d.depends_on_task_id IN (:ids) AND t.status = 'open'
      GROUP BY d.depends_on_task_id`,
    { replacements: { ids: args.taskIds }, transaction: args.transaction }
  );
  for (const row of held as CountRow[]) {
    result.get(row.id)!.unblocks = Number(row.count);
  }
  return result;
};

export const readinessOfTask = async (args: {
  taskId: number;
  transaction?: Transaction;
}): Promise<TaskReadiness> => {
  const map = await readinessOf({
    taskIds: [args.taskId],
    transaction: args.transaction,
  });
  return map.get(args.taskId)!;
};

/** The `listTasks` `blocked` filter's SQL, over the list's `Task` alias. */
export const blockedWhereSql = (blocked: boolean): string => {
  return `${blocked ? '' : 'NOT '}(${HOLD_ACTIVE_SQL('"Task"')} OR EXISTS (
    SELECT 1 FROM task_dependencies d
      JOIN tasks b ON b.id = d.depends_on_task_id
     WHERE d.task_id = "Task"."id" AND b.status = 'open'))`;
};

/**
 * The `listTasks` `upstream_of` filter's SQL, over the list's `Task` alias:
 * every task `rootId` depends on, transitively, through closed ones too.
 * `UNION` keeps a shared dependency from being walked twice.
 */
export const upstreamWhereSql = (rootId: number): string => {
  return `"Task"."id" IN (WITH RECURSIVE upstream(id) AS (
      SELECT d.depends_on_task_id FROM task_dependencies d
       WHERE d.task_id = ${Math.trunc(rootId)}
      UNION
      SELECT d.depends_on_task_id FROM task_dependencies d
        JOIN upstream u ON d.task_id = u.id)
    SELECT id FROM upstream)`;
};

/** `readiness.unblocks` as SQL over the list's `Task` alias. */
export const unblocksSql = (): string => {
  return `(SELECT COUNT(*) FROM task_dependencies d
      JOIN tasks t ON t.id = d.task_id
     WHERE d.depends_on_task_id = "Task"."id" AND t.status = 'open')`;
};

/**
 * Of `candidateIds`, the open tasks left with no open dependency. Locks each
 * candidate first, in id order, so two writers freeing one task serialize and
 * only the later sees it free: `tasks.unblocked` fires once. With `via`, only
 * a candidate still depending on `via` counts, so a close racing the removal
 * of that edge is not a second freeing.
 */
export const freedAmong = async (args: {
  candidateIds: number[];
  via?: number;
  transaction: Transaction;
}): Promise<number[]> => {
  if (args.candidateIds.length === 0) return [];
  await db.sequelize.query(
    `SELECT id FROM tasks WHERE id IN (:ids) ORDER BY id FOR UPDATE`,
    { replacements: { ids: args.candidateIds }, transaction: args.transaction }
  );
  const [rows] = await db.sequelize.query(
    `SELECT t.id FROM tasks t
      WHERE t.id IN (:ids) AND t.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
            JOIN tasks b ON b.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND b.status = 'open')
        ${
          args.via === undefined
            ? ''
            : `AND EXISTS (SELECT 1 FROM task_dependencies v
                WHERE v.task_id = t.id AND v.depends_on_task_id = :via)`
        }`,
    {
      replacements: { ids: args.candidateIds, via: args.via ?? null },
      transaction: args.transaction,
    }
  );
  return (rows as { id: number }[]).map((row) => {
    return row.id;
  });
};

/** What closing `taskId` frees, inside the closing transaction. */
export const freedByClose = async (args: {
  taskId: number;
  transaction: Transaction;
}): Promise<number[]> => {
  const rows = await db.TaskDependency.findAll({
    where: { dependsOnTaskId: args.taskId },
    attributes: ['taskId'],
    transaction: args.transaction,
  });
  return freedAmong({
    candidateIds: rows.map((row) => {
      return row.taskId;
    }),
    via: args.taskId,
    transaction: args.transaction,
  });
};
