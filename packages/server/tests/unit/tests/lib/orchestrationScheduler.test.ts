import { db } from 'src/db';
import { DomainError } from 'src/errors';
import * as eventBusModule from 'src/lib/eventBus';
import * as engineModule from 'src/lib/orchestrationEngine';
import {
  emitRunLifecycleEvent,
  lifecycleEventForStatus,
} from 'src/lib/orchestrationEvents';
import * as runHelpersModule from 'src/lib/orchestrationRunHelpers';
import type { MappedOrchestrationRun } from 'src/lib/orchestrations';
import {
  initializeOrchestrationScheduler,
  runDueScheduledResumptions,
  stopOrchestrationScheduler,
} from 'src/lib/orchestrationScheduler';
import * as startRunModule from 'src/lib/orchestrationStartRun';

const fakeRun: MappedOrchestrationRun = {
  id: 'orch_run_fake',
  orchestrationId: 'orch_fake',
  projectId: 'prj_fake',
  status: 'completed',
  state: {},
  activeNodes: [],
  artifacts: {},
  error: null,
  requiredAction: null,
  traceId: null,
  input: null,
  output: null,
  nodeExecutions: [],
  startedAt: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const flush = () => {
  return new Promise<void>((resolve) => {
    return setImmediate(resolve);
  });
};

describe('orchestrationEvents', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('lifecycleEventForStatus maps terminal/paused statuses and ignores others', () => {
    expect(lifecycleEventForStatus('paused')).toBe('paused');
    expect(lifecycleEventForStatus('completed')).toBe('completed');
    expect(lifecycleEventForStatus('failed')).toBe('failed');
    expect(lifecycleEventForStatus('running')).toBeNull();
    expect(lifecycleEventForStatus('cancelled')).toBeNull();
  });

  test('emitRunLifecycleEvent emits a webhook event on success', async () => {
    jest
      .spyOn(eventBusModule, 'resolveProjectPublicId')
      .mockResolvedValueOnce('prj_1');
    const events: eventBusModule.SoatEvent[] = [];
    const listener = (e: eventBusModule.SoatEvent) => {
      events.push(e);
    };
    eventBusModule.eventBus.on('soat:event', listener);
    try {
      emitRunLifecycleEvent({ event: 'completed', projectId: 1, run: fakeRun });
      await flush();
      const match = events.find((e) => {
        return e.type === 'orchestration_runs.completed';
      });
      expect(match).toBeDefined();
      expect(match?.resourceType).toBe('orchestration_run');
      expect(match?.resourceId).toBe('orch_run_fake');
    } finally {
      eventBusModule.eventBus.off('soat:event', listener);
    }
  });

  test('emitRunLifecycleEvent swallows a project-lookup failure', async () => {
    jest
      .spyOn(eventBusModule, 'resolveProjectPublicId')
      .mockRejectedValueOnce(new Error('lookup failed'));
    expect(() => {
      emitRunLifecycleEvent({ event: 'failed', projectId: 1, run: fakeRun });
    }).not.toThrow();
    await flush();
  });
});

describe('orchestrationScheduler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    stopOrchestrationScheduler();
  });

  describe('runDueScheduledResumptions', () => {
    test('returns 0 when no runs are due', async () => {
      const count = await runDueScheduledResumptions({ now: new Date(0) });
      expect(count).toBe(0);
    });

    test('returns 0 and swallows a query failure', async () => {
      jest
        .spyOn(db.OrchestrationRun, 'findAll')
        .mockRejectedValueOnce(new Error('db unavailable'));
      const count = await runDueScheduledResumptions();
      expect(count).toBe(0);
    });

    test('claims a due run and hands it to the resumer', async () => {
      const run = { id: 987654 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      const updateSpy = jest
        .spyOn(db.OrchestrationRun, 'update')
        .mockResolvedValueOnce([1]);
      const resumeSpy = jest
        .spyOn(engineModule, 'resumeScheduledRun')
        .mockResolvedValueOnce(undefined);

      const count = await runDueScheduledResumptions({ now: new Date() });

      expect(count).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        { resumeAt: null },
        expect.objectContaining({
          where: expect.objectContaining({ id: 987654 }),
        })
      );
      await flush();
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });

    test('skips a run it fails to claim', async () => {
      const run = { id: 111222 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      jest.spyOn(db.OrchestrationRun, 'update').mockResolvedValueOnce([0]);
      const resumeSpy = jest.spyOn(engineModule, 'resumeScheduledRun');

      const count = await runDueScheduledResumptions({ now: new Date() });

      expect(count).toBe(0);
      expect(resumeSpy).not.toHaveBeenCalled();
    });

    test('swallows a resumer failure without rejecting', async () => {
      const run = { id: 333444 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      jest.spyOn(db.OrchestrationRun, 'update').mockResolvedValueOnce([1]);
      const resumeSpy = jest
        .spyOn(engineModule, 'resumeScheduledRun')
        .mockRejectedValueOnce(new Error('resume blew up'));

      const count = await runDueScheduledResumptions({ now: new Date() });

      expect(count).toBe(1);
      // The rejection is caught internally; flushing must not surface it.
      await flush();
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('initializeOrchestrationScheduler', () => {
    test('is a no-op under the test environment', () => {
      expect(() => {
        return initializeOrchestrationScheduler();
      }).not.toThrow();
    });

    test('starts a timer outside the test environment and is idempotent', () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevJestWorker = process.env.JEST_WORKER_ID;
      delete process.env.NODE_ENV;
      delete process.env.JEST_WORKER_ID;
      try {
        // Large interval so the timer never fires during the test.
        initializeOrchestrationScheduler({ intervalMs: 3_600_000 });
        // Second call short-circuits because a timer already exists.
        initializeOrchestrationScheduler({ intervalMs: 3_600_000 });
      } finally {
        stopOrchestrationScheduler();
        process.env.NODE_ENV = prevNodeEnv;
        if (prevJestWorker === undefined) {
          delete process.env.JEST_WORKER_ID;
        } else {
          process.env.JEST_WORKER_ID = prevJestWorker;
        }
      }
    });

    test('falls back to the default interval for an invalid override', () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevJestWorker = process.env.JEST_WORKER_ID;
      delete process.env.NODE_ENV;
      delete process.env.JEST_WORKER_ID;
      try {
        initializeOrchestrationScheduler({ intervalMs: 0 });
      } finally {
        stopOrchestrationScheduler();
        process.env.NODE_ENV = prevNodeEnv;
        if (prevJestWorker === undefined) {
          delete process.env.JEST_WORKER_ID;
        } else {
          process.env.JEST_WORKER_ID = prevJestWorker;
        }
      }
    });

    test('ticks the resumer on its interval', async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevJestWorker = process.env.JEST_WORKER_ID;
      delete process.env.NODE_ENV;
      delete process.env.JEST_WORKER_ID;
      const findAllSpy = jest
        .spyOn(db.OrchestrationRun, 'findAll')
        .mockResolvedValue([]);
      try {
        initializeOrchestrationScheduler({ intervalMs: 20 });
        await new Promise<void>((resolve) => {
          return setTimeout(resolve, 80);
        });
        expect(findAllSpy).toHaveBeenCalled();
      } finally {
        stopOrchestrationScheduler();
        process.env.NODE_ENV = prevNodeEnv;
        if (prevJestWorker === undefined) {
          delete process.env.JEST_WORKER_ID;
        } else {
          process.env.JEST_WORKER_ID = prevJestWorker;
        }
      }
    });
  });
});

describe('resumeScheduledRun (branch coverage)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no-ops when the run has no resume context', async () => {
    const run = {
      id: 1,
      resumeContext: null,
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    await expect(
      engineModule.resumeScheduledRun({ run })
    ).resolves.toBeUndefined();
  });

  test('marks the run failed when its orchestration no longer exists', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const run = {
      id: 2,
      orchestrationId: 42,
      resumeContext: {
        nodeId: 'delay',
        resume: { kind: 'delay', artifact: {} },
      },
      update,
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    jest.spyOn(db.Orchestration, 'findOne').mockResolvedValueOnce(null);

    await engineModule.resumeScheduledRun({ run });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', resumeAt: null })
    );
  });
});

describe('resumeOrchestrationRunExecution (branch coverage)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('throws when the orchestration is missing', async () => {
    jest.spyOn(db.Orchestration, 'findOne').mockResolvedValueOnce(null);
    const run = {
      id: 3,
      orchestrationId: 99,
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    await expect(
      engineModule.resumeOrchestrationRunExecution({ run })
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe('startOrchestrationRun background error handling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('swallows an error thrown by the async background drive', async () => {
    const fakeOrch = {
      id: 1,
      projectId: 1,
      nodes: [],
      edges: [],
    } as unknown as InstanceType<typeof db.Orchestration>;
    jest
      .spyOn(startRunModule, 'findOrchestrationForStartRun')
      .mockResolvedValue(fakeOrch);
    const runRecord = {
      id: 5,
      traceId: null,
      projectId: 1,
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    jest.spyOn(db.OrchestrationRun, 'create').mockResolvedValue(runRecord);
    jest
      .spyOn(runHelpersModule, 'mapRunWithIncludes')
      .mockResolvedValueOnce(fakeRun)
      .mockRejectedValueOnce(new Error('map failed during settle'));

    const result = await engineModule.startOrchestrationRun({
      orchestrationPublicId: 'orch_x',
    });

    // Returns the initial run immediately; the background failure is swallowed.
    expect(result).toBe(fakeRun);
    await new Promise<void>((resolve) => {
      return setTimeout(resolve, 100);
    });
  });
});
