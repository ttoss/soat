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
  reapOrphanedRuns,
  startOrchestrationScheduler,
  stopOrchestrationScheduler,
  wakeDueRuns,
} from 'src/lib/orchestrationScheduler';
import * as startRunModule from 'src/lib/orchestrationStartRun';

const fakeRun: MappedOrchestrationRun = {
  id: 'orch_run_fake',
  orchestrationId: 'orch_fake',
  projectId: 'prj_fake',
  status: 'succeeded',
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

  test('lifecycleEventForStatus maps terminal/awaiting_input statuses and ignores others', () => {
    expect(lifecycleEventForStatus('awaiting_input')).toBe('awaitingInput');
    expect(lifecycleEventForStatus('succeeded')).toBe('succeeded');
    expect(lifecycleEventForStatus('failed')).toBe('failed');
    expect(lifecycleEventForStatus('running')).toBeNull();
    expect(lifecycleEventForStatus('sleeping')).toBeNull();
    expect(lifecycleEventForStatus('queued')).toBeNull();
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
      emitRunLifecycleEvent({ event: 'succeeded', projectId: 1, run: fakeRun });
      await flush();
      const match = events.find((e) => {
        return e.type === 'orchestration_runs.succeeded';
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

  describe('wakeDueRuns', () => {
    test('returns 0 when no runs are due', async () => {
      const count = await wakeDueRuns({ now: new Date(0) });
      expect(count).toBe(0);
    });

    test('returns 0 and swallows a query failure', async () => {
      jest
        .spyOn(db.OrchestrationRun, 'findAll')
        .mockRejectedValueOnce(new Error('db unavailable'));
      const count = await wakeDueRuns();
      expect(count).toBe(0);
    });

    test('claims a due sleeping run and hands it to the waker', async () => {
      const run = { id: 987654 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      const updateSpy = jest
        .spyOn(db.OrchestrationRun, 'update')
        .mockResolvedValueOnce([1]);
      const wakeSpy = jest
        .spyOn(engineModule, 'wakeRun')
        .mockResolvedValueOnce(undefined);

      const count = await wakeDueRuns({ now: new Date() });

      expect(count).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          wakeAt: null,
          leaseExpiresAt: expect.any(Date),
        }),
        expect.objectContaining({
          where: expect.objectContaining({ id: 987654 }),
        })
      );
      await flush();
      expect(wakeSpy).toHaveBeenCalledTimes(1);
    });

    test('skips a run it fails to claim', async () => {
      const run = { id: 111222 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      jest.spyOn(db.OrchestrationRun, 'update').mockResolvedValueOnce([0]);
      const wakeSpy = jest.spyOn(engineModule, 'wakeRun');

      const count = await wakeDueRuns({ now: new Date() });

      expect(count).toBe(0);
      expect(wakeSpy).not.toHaveBeenCalled();
    });

    test('swallows a waker failure without rejecting', async () => {
      const run = { id: 333444 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      jest.spyOn(db.OrchestrationRun, 'update').mockResolvedValueOnce([1]);
      const wakeSpy = jest
        .spyOn(engineModule, 'wakeRun')
        .mockRejectedValueOnce(new Error('wake blew up'));

      const count = await wakeDueRuns({ now: new Date() });

      expect(count).toBe(1);
      // The rejection is caught internally; flushing must not surface it.
      await flush();
      expect(wakeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('reapOrphanedRuns', () => {
    test('returns 0 when no runs are orphaned', async () => {
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([]);
      const count = await reapOrphanedRuns({ now: new Date() });
      expect(count).toBe(0);
    });

    test('returns 0 and swallows a query failure', async () => {
      jest
        .spyOn(db.OrchestrationRun, 'findAll')
        .mockRejectedValueOnce(new Error('db unavailable'));
      const count = await reapOrphanedRuns();
      expect(count).toBe(0);
    });

    test('claims an orphaned running run and hands it to the redriver', async () => {
      const run = { id: 424242 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      const updateSpy = jest
        .spyOn(db.OrchestrationRun, 'update')
        .mockResolvedValueOnce([1]);
      const redriveSpy = jest
        .spyOn(engineModule, 'redriveRun')
        .mockResolvedValueOnce(undefined);

      const count = await reapOrphanedRuns({ now: new Date() });

      expect(count).toBe(1);
      // The claim extends the lease guarded on the run still being running with
      // an expired lease, so a single reaper reclaims it.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ leaseExpiresAt: expect.any(Date) }),
        expect.objectContaining({
          where: expect.objectContaining({ id: 424242, status: 'running' }),
        })
      );
      await flush();
      expect(redriveSpy).toHaveBeenCalledTimes(1);
    });

    test('skips a run it fails to claim', async () => {
      const run = { id: 555666 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      jest.spyOn(db.OrchestrationRun, 'update').mockResolvedValueOnce([0]);
      const redriveSpy = jest.spyOn(engineModule, 'redriveRun');

      const count = await reapOrphanedRuns({ now: new Date() });

      expect(count).toBe(0);
      expect(redriveSpy).not.toHaveBeenCalled();
    });

    test('swallows a redrive failure without rejecting', async () => {
      const run = { id: 777888 } as InstanceType<typeof db.OrchestrationRun>;
      jest.spyOn(db.OrchestrationRun, 'findAll').mockResolvedValueOnce([run]);
      jest.spyOn(db.OrchestrationRun, 'update').mockResolvedValueOnce([1]);
      const redriveSpy = jest
        .spyOn(engineModule, 'redriveRun')
        .mockRejectedValueOnce(new Error('redrive blew up'));

      const count = await reapOrphanedRuns({ now: new Date() });

      expect(count).toBe(1);
      await flush();
      expect(redriveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('startOrchestrationScheduler', () => {
    // Fake timers keep the interval under the test's control: no real waiting,
    // no leaked timer, and no need to sniff the environment in production code.
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      stopOrchestrationScheduler();
      jest.useRealTimers();
    });

    // Each tick runs both sweeps (wakeDueRuns + reapOrphanedRuns), so findAll is
    // queried twice per tick.
    test('drives the sweeps on each interval tick and is idempotent', async () => {
      const findAllSpy = jest
        .spyOn(db.OrchestrationRun, 'findAll')
        .mockResolvedValue([]);

      startOrchestrationScheduler({ intervalMs: 5000 });
      // Second call short-circuits because a timer already exists.
      startOrchestrationScheduler({ intervalMs: 5000 });

      await jest.advanceTimersByTimeAsync(5000);
      expect(findAllSpy).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(5000);
      expect(findAllSpy).toHaveBeenCalledTimes(4);
    });

    test('falls back to the default interval for an invalid override', async () => {
      const findAllSpy = jest
        .spyOn(db.OrchestrationRun, 'findAll')
        .mockResolvedValue([]);

      startOrchestrationScheduler({ intervalMs: 0 });

      // Nothing fires before the default 5s interval elapses.
      await jest.advanceTimersByTimeAsync(4999);
      expect(findAllSpy).not.toHaveBeenCalled();
      // One tick → both sweeps query once each.
      await jest.advanceTimersByTimeAsync(1);
      expect(findAllSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('wakeRun (branch coverage)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no-ops when the run has no wake context', async () => {
    const run = {
      id: 1,
      wakeContext: null,
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    await expect(engineModule.wakeRun({ run })).resolves.toBeUndefined();
  });

  test('marks the run failed when its orchestration no longer exists', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const run = {
      id: 2,
      orchestrationId: 42,
      wakeContext: {
        nodeId: 'delay',
        resume: { kind: 'delay', artifact: {} },
      },
      update,
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    jest.spyOn(db.Orchestration, 'findOne').mockResolvedValueOnce(null);

    await engineModule.wakeRun({ run });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', wakeAt: null })
    );
  });
});

describe('redriveRun (branch coverage)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('marks the run failed and clears the lease when its orchestration is gone', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const run = {
      id: 9,
      orchestrationId: 77,
      update,
    } as unknown as InstanceType<typeof db.OrchestrationRun>;
    jest.spyOn(db.Orchestration, 'findOne').mockResolvedValueOnce(null);

    await engineModule.redriveRun({ run });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        leaseExpiresAt: null,
      })
    );
  });
});

describe('buildRedriveEntry', () => {
  const nodes = [
    { id: 'a', type: 'transform' },
    { id: 'b', type: 'transform' },
    { id: 'c', type: 'transform' },
  ] as Parameters<typeof engineModule.buildRedriveEntry>[0]['nodes'];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];

  test('restarts from start nodes when nothing was checkpointed', () => {
    const entry = engineModule.buildRedriveEntry({
      nodes,
      edges,
      artifacts: {},
    });
    expect([...entry.activatedNodes]).toEqual(['a']);
    expect(entry.completedNodes.size).toBe(0);
  });

  test('resumes the not-yet-completed successor of the last completed node', () => {
    const entry = engineModule.buildRedriveEntry({
      nodes,
      edges,
      artifacts: { a: { result: 1 } },
    });
    // `a` is completed → `b` is the frontier; `a` is not re-activated.
    expect([...entry.activatedNodes]).toEqual(['b']);
    expect(entry.completedNodes.has('a')).toBe(true);
  });

  test('yields an empty frontier when every node completed (settles on redrive)', () => {
    const entry = engineModule.buildRedriveEntry({
      nodes,
      edges,
      artifacts: { a: {}, b: {}, c: {} },
    });
    expect([...entry.activatedNodes]).toEqual([]);
  });

  test('re-activates an uncompleted parallel start branch', () => {
    const parallelNodes = [
      { id: 'x', type: 'transform' },
      { id: 'y', type: 'transform' },
    ] as Parameters<typeof engineModule.buildRedriveEntry>[0]['nodes'];
    // Two independent start nodes; `x` checkpointed, `y` crashed mid-execution.
    const entry = engineModule.buildRedriveEntry({
      nodes: parallelNodes,
      edges: [],
      artifacts: { x: {} },
    });
    expect([...entry.activatedNodes]).toEqual(['y']);
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
