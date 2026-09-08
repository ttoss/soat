import createDebug from 'debug';

import { applyLocked, stillInState } from './tasksAutomationLocking';

const log = createDebug('soat:tasks');

/**
 * An operator pause on a workflow instance (#1237).
 *
 * A workflow has no run object — its instance is the task — so the pause an
 * orchestration run gets lands here instead, and it stops the only work a task
 * drives on its own: a state's `on_enter` dispatch and the retry chain behind
 * it. Everything else about the task keeps working, transitions included: a move
 * costs nothing while every dispatch it would start is suppressed, so a board
 * stays usable under a pause instead of freezing.
 *
 * The suppressed dispatch is recorded as `automation_status: 'paused'`, which is
 * what `resumeTask` reads to know the state's `on_enter` never ran and must be
 * dispatched now. Without it a resume would either re-dispatch a state whose
 * work had already completed, or leave a state that never dispatched stuck.
 */

/** `automation_status` for a dispatch a pause suppressed, awaiting the resume. */
export const PAUSED_AUTOMATION_STATUS = 'paused';

export const isTaskPaused = (task: {
  pauseRequestedAt: Date | null;
}): boolean => {
  return task.pauseRequestedAt != null;
};

/**
 * Records that the state's dispatch was suppressed by the pause, under the same
 * staleness guard every other dispatch write uses — a task that left the state
 * meanwhile has nothing to suppress. `activeDispatch` is cleared because none
 * was started; a `null` id with a `running` status would read as one in flight.
 */
export const markDispatchPaused = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
}): Promise<void> => {
  await applyLocked({
    taskPublicId: args.taskPublicId,
    guard: stillInState({ stateName: args.stateName, token: args.token }),
    mutate: (task) => {
      task.activeDispatch = null;
      task.automationStatus = PAUSED_AUTOMATION_STATUS;
    },
  });
  log(
    'markDispatchPaused: task=%s state=%s',
    args.taskPublicId,
    args.stateName
  );
};
