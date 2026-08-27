import { db } from 'src/db';

/**
 * Row-level helpers shared by the automation runner (`tasksAutomation`) and its
 * retry loop (`tasksAutomationRetry`). Kept in their own module so both can read
 * and write a task's dispatch state under the same staleness rule without one
 * importing the other.
 */
export type TaskWithWorkflow = InstanceType<(typeof db)['Task']> & {
  project?: InstanceType<(typeof db)['Project']>;
  workflow?: InstanceType<(typeof db)['Workflow']>;
};

export const loadTask = async (
  id: string
): Promise<TaskWithWorkflow | null> => {
  return db.Task.findOne({
    where: { publicId: id },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Workflow, as: 'workflow' },
    ],
  }) as Promise<TaskWithWorkflow | null>;
};

/** Whether the task is still parked in the state whose automation we launched. */
export const isStale = (args: {
  task: TaskWithWorkflow | null;
  stateName: string;
  token: number;
}): boolean => {
  if (!args.task) return true;
  if (args.task.state !== args.stateName) return true;
  const enteredAt = args.task.enteredStateAt as Date;
  return enteredAt.getTime() !== args.token;
};

// Locks the row, re-runs `guard` against the locked read and only then writes,
// all in one transaction — so no concurrent `transitionTask` can commit between
// the check and the write. Returns `null` when the guard rejected, which is
// exactly where a plain read-check-write clobbered it with stale data (#590).
export const applyLocked = async (args: {
  taskPublicId: string;
  guard: (task: TaskWithWorkflow) => boolean;
  mutate: (task: TaskWithWorkflow) => void;
}): Promise<TaskWithWorkflow | null> => {
  return db.sequelize.transaction(async (t) => {
    const task = (await db.Task.findOne({
      where: { publicId: args.taskPublicId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    })) as TaskWithWorkflow | null;
    if (!task || !args.guard(task)) return null;
    args.mutate(task);
    await task.save({ transaction: t });
    return task;
  });
};

/** Guards a write on the task still sitting in the state we dispatched from. */
export const stillInState = (args: {
  stateName: string;
  token: number;
}): ((task: TaskWithWorkflow) => boolean) => {
  return (task) => {
    return !isStale({ task, stateName: args.stateName, token: args.token });
  };
};
