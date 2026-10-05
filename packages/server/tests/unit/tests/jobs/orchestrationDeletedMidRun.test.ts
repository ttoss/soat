import {
  driveQueuedRun,
  redriveRun,
  wakeRun,
} from 'src/lib/orchestrationEngine';

import {
  type RunInstance,
  setupDeletedOrchestrationRuns,
} from '../../fixtures/deletedOrchestrationRun';

/**
 * The background drivers handed a run whose orchestration was deleted after
 * they loaded it: the queue worker (`driveQueuedRun`) and the scheduler's wake
 * and reap sweeps (`wakeRun`, `redriveRun`). Each is handed the in-memory run
 * the race leaves behind.
 */
describe('a background driver handed a run whose orchestration is gone', () => {
  const LEASE = new Date(Date.now() - 60_000);
  const WAKE_CONTEXT = {
    nodeId: 'delay',
    resume: { kind: 'delay', artifact: {} },
  };

  let runOfDeletedOrchestration: (
    overrides: Record<string, unknown>
  ) => Promise<RunInstance>;

  beforeAll(async () => {
    ({ runOfDeletedOrchestration } = await setupDeletedOrchestrationRuns({
      prefix: 'orchdeleteddriver',
    }));
  });

  // One terminal state for all three: a failed run holds neither a lease the
  // reaper would act on nor a wake the scheduler would.
  test.each<
    [string, Record<string, unknown>, (run: RunInstance) => Promise<void>]
  >([
    [
      'driveQueuedRun',
      { status: 'queued', leaseExpiresAt: LEASE, wakeContext: WAKE_CONTEXT },
      (run) => {
        return driveQueuedRun({ run });
      },
    ],
    [
      'wakeRun',
      {
        status: 'sleeping',
        wakeAt: new Date(Date.now() - 1000),
        leaseExpiresAt: LEASE,
        wakeContext: WAKE_CONTEXT,
      },
      (run) => {
        return wakeRun({ run });
      },
    ],
    [
      'redriveRun',
      { status: 'running', leaseExpiresAt: LEASE, wakeContext: WAKE_CONTEXT },
      (run) => {
        return redriveRun({ run });
      },
    ],
  ])(
    '%s fails it, clearing the lease and the wake',
    async (_name, overrides, drive) => {
      const run = await runOfDeletedOrchestration(overrides);

      await drive(run);

      expect(run.status).toBe('failed');
      expect(run.leaseExpiresAt).toBeNull();
      expect(run.wakeAt).toBeNull();
      expect(run.wakeContext).toBeNull();
      expect(run.completedAt).toBeInstanceOf(Date);
      expect(run.error).toEqual({
        code: 'ORCHESTRATION_NOT_FOUND',
        message: 'Orchestration gone',
      });
    }
  );
});
