import type { TaskHistoryKind } from '@soat/postgresdb';
import { db } from 'src/db';

import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import { paginatedList } from './pagination';

type TaskHistoryRow = NonNullable<
  Parameters<typeof db.TaskTransition.create>[0]
> & { taskId: number; kind: TaskHistoryKind };

/**
 * The one writer of a task's history. History lists by `createdAt`, so each row
 * is stamped strictly after the task's latest one: two rows in one millisecond
 * would otherwise list in public-id order, which is random.
 */
export const appendTaskHistory = async (args: {
  row: TaskHistoryRow;
  transaction?: Transaction;
}): Promise<void> => {
  const latest = await db.TaskTransition.findOne({
    where: { taskId: args.row.taskId },
    order: [['createdAt', 'DESC']],
    attributes: ['createdAt'],
    transaction: args.transaction,
  });
  const now = Date.now();
  const floor = latest ? latest.createdAt.getTime() + 1 : now;
  const createdAt = new Date(Math.max(now, floor));
  await db.TaskTransition.create(
    { ...args.row, createdAt },
    { transaction: args.transaction }
  );
};

export const getTaskHistory = async (args: {
  id: string;
  limit?: number;
  cursor?: string;
}) => {
  const task = await db.Task.findOne({ where: { publicId: args.id } });
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task '${args.id}' not found.`);
  }
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: { id: args.id },
    where: { taskId: task.id as number },
    order: [['createdAt', 'ASC']],
    query: ({ where, limit, order }) => {
      return db.TaskTransition.findAll({ where, limit, order });
    },
    map: (row) => {
      return {
        id: row.publicId,
        task_id: task.publicId,
        kind: row.kind,
        related_task_id: row.relatedTaskId ?? null,
        from_state: row.fromState,
        to_state: row.toState,
        transition: row.transition,
        principal_type: row.principalType,
        principal_id: row.principalId,
        generation_id: row.generationId,
        orchestration_run_id: row.orchestrationRunId,
        tool_id: row.toolId,
        note: row.note,
        from_workflow_version: row.fromWorkflowVersion ?? null,
        to_workflow_version: row.toWorkflowVersion ?? null,
        created_at: row.createdAt,
      };
    },
  });
};
