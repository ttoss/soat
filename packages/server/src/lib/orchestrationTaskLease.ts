import createDebug from 'debug';

import {
  type ClaimedTask,
  getOrchestrationQueueDriver,
} from './orchestration-queue-drivers';
import { taskLeaseTtlMs } from './orchestration-queue-drivers/config';

const log = createDebug('soat:orchestrations');

// A third of the lease: two heartbeats may be lost before a task becomes
// claimable again, which keeps a slow database or a throttled SQS call from
// handing a live drive to a second worker.
const HEARTBEAT_DIVISOR = 3;

export const leaseHeartbeatMs = (): number => {
  return Math.max(1, Math.floor(taskLeaseTtlMs() / HEARTBEAT_DIVISOR));
};

/**
 * Runs `run` with the task's lease held for as long as it takes.
 *
 * A lease that lapses mid-drive is not a crashed worker, but the queue cannot
 * tell the two apart: it redelivers, a second worker drives the same run, and
 * every side effect the run issues happens twice — a keyed node's `running` row
 * is taken over rather than reused, so an `agent` node bills a second
 * generation per redelivery. The heartbeat is what reserves redelivery for a
 * worker that actually stopped.
 *
 * A failed heartbeat is logged and not thrown: the drive is the work, and the
 * next beat may well succeed.
 */
export const withTaskLeaseHeld = async <T>(args: {
  task: ClaimedTask;
  run: () => Promise<T>;
  intervalMs?: number;
}): Promise<T> => {
  const driver = getOrchestrationQueueDriver();
  const timer = setInterval(() => {
    void driver.extendLease({ task: args.task }).catch((error: unknown) => {
      log(
        'withTaskLeaseHeld: heartbeat failed task=%s %o',
        args.task.id,
        error
      );
    });
  }, args.intervalMs ?? leaseHeartbeatMs());
  // Nothing should be kept alive by a heartbeat: the process may exit between
  // drives.
  timer.unref?.();

  try {
    return await args.run();
  } finally {
    clearInterval(timer);
  }
};
