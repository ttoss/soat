import { db } from 'src/db';

import type { Transaction } from './dbTransaction';

type TaskHistoryRow = NonNullable<
  Parameters<typeof db.TaskTransition.create>[0]
> & { taskId: number };

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
