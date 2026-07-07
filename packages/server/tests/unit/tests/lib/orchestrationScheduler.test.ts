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

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

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

// Kept per the scheduler's timer-free design: after wakeDueRuns/reapOrphanedRuns
// return, the actual wake/redrive runs as a detached `void` promise. Flushing a
// setImmediate lets that fire-and-forget work start before assertions.
const flush = () => {
  return new Promise<void>((resolve) => {
    return setImmediate(resolve);
  });
};

// ── Real-DB fixtures ──────────────────────────────────────────────────────
//
// The scheduler is a real entry point, so these tests drive it against the real
// database rather than stubbing `db.*`. A project and two orchestrations are set
// up once; individual runs are created directly as DB rows to model the parked /
// orphaned states the scheduler reclaims.

let userToken: string;
let projectPublicId: string;
let projectPk: number;
let transformOrchPublicId: string;
let transformOrchPk: number;
let delayOrchPk: number;

let ephemeralOrchSeq = 0;

const createOrchestration = async (
  body: Record<string, unknown>
): Promise<string> => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({ ...body, project_id: projectPublicId });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const orchPk = async (publicId: string): Promise<number> => {
  const orch = await db.Orchestration.findOne({ where: { publicId } });
  return orch?.id as number;
};

// A sleeping run parked on a `delay` node whose wake is already due — the shape
// wakeDueRuns claims and hands to the waker.
const createDueSleepingRun = (args?: { wakeAt?: Date }) => {
  return db.OrchestrationRun.create({
    orchestrationId: delayOrchPk,
    projectId: projectPk,
    status: 'sleeping',
    state: {},
    activeNodes: ['delay'],
    artifacts: {},
    input: {},
    startedAt: new Date(),
    wakeAt: args?.wakeAt ?? new Date(Date.now() - 1000),
    wakeContext: {
      nodeId: 'delay',
      resume: { kind: 'delay', artifact: { waited: '1s' } },
    },
  });
};

// A `running` run whose lease already expired — its driver crashed mid-flight,
// so the reaper must reclaim and re-drive it.
const createOrphanedRun = () => {
  return db.OrchestrationRun.create({
    orchestrationId: transformOrchPk,
    projectId: projectPk,
    status: 'running',
    state: {},
    activeNodes: [],
    artifacts: {},
    input: {},
    startedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() - 60_000),
  });
};

// Creates a run whose orchestration is then deleted. The FK cascades and removes
// the run row, but the in-memory instance survives — modelling the (real, if
// rare) state where the scheduler wakes a run whose orchestration is gone.
const createRunWithMissingOrchestration = async (
  overrides: Record<string, unknown>
) => {
  ephemeralOrchSeq += 1;
  const pub = await createOrchestration({
    name: `Ephemeral ${ephemeralOrchSeq}`,
    nodes: [{ id: 'start', type: 'transform', expression: 'x' }],
    edges: [],
  });
  const pk = await orchPk(pub);
  const run = await db.OrchestrationRun.create({
    orchestrationId: pk,
    projectId: projectPk,
    state: {},
    activeNodes: [],
    artifacts: {},
    input: {},
    ...overrides,
  });
  await db.Orchestration.destroy({ where: { id: pk } });
  return run;
};

// Polls a run row until it reaches one of `statuses`. Uses no timer APIs so it
// works under both real and fake timers; each real DB round-trip yields to the
// event loop, letting the scheduler's detached wake/redrive work progress.
const waitForRunStatus = async (
  runId: number,
  statuses: string[]
): Promise<InstanceType<typeof db.OrchestrationRun>> => {
  for (let i = 0; i < 3000; i += 1) {
    const run = await db.OrchestrationRun.findByPk(runId);
    if (run && statuses.includes(run.status)) return run;
  }
  throw new Error(`run ${runId} never reached ${statuses.join('/')}`);
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'orchsched',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:StartRun',
      'orchestrations:GetRun',
      'orchestrations:ListRuns',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectPublicId = setup.projectId;
  const project = await db.Project.findOne({
    where: { publicId: projectPublicId },
  });
  projectPk = project?.id as number;

  transformOrchPublicId = await createOrchestration({
    name: 'Sched Transform',
    nodes: [
      {
        id: 'start',
        type: 'transform',
        expression: 'hello',
        output_mapping: { result: 'state.msg' },
      },
      {
        id: 'after',
        type: 'transform',
        expression: 'done',
        output_mapping: { result: 'state.after' },
      },
    ],
    edges: [{ from: 'start', to: 'after' }],
  });
  transformOrchPk = await orchPk(transformOrchPublicId);

  const delayPublicId = await createOrchestration({
    name: 'Sched Delay',
    nodes: [
      {
        id: 'delay',
        type: 'delay',
        duration: '1s',
        output_mapping: { waited: 'state.waited' },
      },
      {
        id: 'after',
        type: 'transform',
        expression: 'done',
        output_mapping: { result: 'state.after' },
      },
    ],
    edges: [{ from: 'delay', to: 'after' }],
  });
  delayOrchPk = await orchPk(delayPublicId);
});

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
    const events: eventBusModule.SoatEvent[] = [];
    const listener = (e: eventBusModule.SoatEvent) => {
      events.push(e);
    };
    eventBusModule.eventBus.on('soat:event', listener);
    try {
      // Real project id → resolveProjectPublicId reads the actual public id.
      emitRunLifecycleEvent({
        event: 'succeeded',
        projectId: projectPk,
        run: fakeRun,
      });
      const match = await (async () => {
        for (let i = 0; i < 3000; i += 1) {
          const found = events.find((e) => {
            return e.type === 'orchestration_runs.succeeded';
          });
          if (found) return found;
          await flush();
        }
        return undefined;
      })();
      expect(match).toBeDefined();
      expect(match?.resourceType).toBe('orchestration_run');
      expect(match?.resourceId).toBe('orch_run_fake');
      expect(match?.projectPublicId).toBe(projectPublicId);
    } finally {
      eventBusModule.eventBus.off('soat:event', listener);
    }
  });

  test('emitRunLifecycleEvent swallows a project-lookup failure', async () => {
    // resolveProjectPublicId never rejects against a live DB (a missing project
    // resolves to ''), so the best-effort catch is exercised by forcing a
    // rejection at the eventBus boundary — not a `db.*` stub.
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
      // Nothing has a wakeAt at or before the epoch, so nothing is claimed.
      const count = await wakeDueRuns({ now: new Date(0) });
      expect(count).toBe(0);
    });

    test('returns 0 and swallows a query failure', async () => {
      // An invalid `now` makes the real `wakeAt <= now` query fail at the DB,
      // exercising the defensive catch without stubbing `db.*`.
      const count = await wakeDueRuns({ now: new Date('not-a-date') });
      expect(count).toBe(0);
    });

    test('claims a due sleeping run and drives it to completion', async () => {
      const run = await createDueSleepingRun();

      const count = await wakeDueRuns({ now: new Date() });
      expect(count).toBeGreaterThanOrEqual(1);

      await flush();
      const settled = await waitForRunStatus(run.id as number, ['succeeded']);
      expect((settled.state as Record<string, unknown>).after).toBe('done');
    });

    test('does not double-claim a run across overlapping ticks', async () => {
      const run = await createDueSleepingRun();

      // Two overlapping sweeps race for the same run; the atomic claim (guarded
      // on wakeAt still being set) plus the in-flight guard let exactly one win.
      const [a, b] = await Promise.all([
        wakeDueRuns({ now: new Date() }),
        wakeDueRuns({ now: new Date() }),
      ]);
      expect(a + b).toBe(1);

      await flush();
      await waitForRunStatus(run.id as number, ['succeeded']);
    });

    test('swallows a waker failure without rejecting', async () => {
      const run = await createDueSleepingRun();
      // The wake itself failing must not surface out of wakeDueRuns. Spying the
      // engine boundary (not `db.*`) is the only way to force that rejection.
      const wakeSpy = jest
        .spyOn(engineModule, 'wakeRun')
        .mockRejectedValueOnce(new Error('wake blew up'));

      const count = await wakeDueRuns({ now: new Date() });
      expect(count).toBe(1);

      // The rejection is caught internally; flushing must not surface it.
      await flush();
      expect(wakeSpy).toHaveBeenCalledTimes(1);
      // The run was claimed (flipped to running) even though the wake failed.
      const claimed = await db.OrchestrationRun.findByPk(run.id as number);
      expect(claimed?.status).toBe('running');
    });
  });

  describe('reapOrphanedRuns', () => {
    test('returns 0 when no runs are orphaned', async () => {
      // No running run has a lease that expired before the epoch.
      const count = await reapOrphanedRuns({ now: new Date(0) });
      expect(count).toBe(0);
    });

    test('returns 0 and swallows a query failure', async () => {
      // An invalid `now` makes the real `leaseExpiresAt < now` query fail at the
      // DB, exercising the defensive catch without stubbing `db.*`.
      const count = await reapOrphanedRuns({ now: new Date('not-a-date') });
      expect(count).toBe(0);
    });

    test('claims an orphaned running run and drives it to completion', async () => {
      const orphan = await createOrphanedRun();

      const count = await reapOrphanedRuns({ now: new Date() });
      expect(count).toBeGreaterThanOrEqual(1);

      await flush();
      const settled = await waitForRunStatus(orphan.id as number, [
        'succeeded',
      ]);
      expect((settled.state as Record<string, unknown>).msg).toBe('hello');
      expect((settled.state as Record<string, unknown>).after).toBe('done');
    });

    test('does not reclaim a running run whose lease is still fresh', async () => {
      const healthy = await db.OrchestrationRun.create({
        orchestrationId: transformOrchPk,
        projectId: projectPk,
        status: 'running',
        state: {},
        activeNodes: [],
        artifacts: {},
        input: {},
        startedAt: new Date(),
        // Lease still valid → a live driver is holding it.
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });

      await reapOrphanedRuns({ now: new Date() });

      const after = await db.OrchestrationRun.findByPk(healthy.id as number);
      expect(after?.status).toBe('running');
    });

    test('swallows a redrive failure without rejecting', async () => {
      await createOrphanedRun();
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

    test('drives both sweeps on each interval tick and is idempotent', async () => {
      const sleeping = await createDueSleepingRun();
      const orphan = await createOrphanedRun();

      startOrchestrationScheduler({ intervalMs: 5000 });
      // Second call short-circuits because a timer already exists.
      startOrchestrationScheduler({ intervalMs: 5000 });

      await jest.advanceTimersByTimeAsync(5000);

      // wakeDueRuns claimed the sleeping run and reapOrphanedRuns re-drove the
      // orphan — both sweeps fired on the single tick.
      await waitForRunStatus(sleeping.id as number, ['running', 'succeeded']);
      await waitForRunStatus(orphan.id as number, ['succeeded']);

      // Once stopped, no leaked timer keeps ticking: a freshly-due run is left
      // untouched even after another interval elapses.
      stopOrchestrationScheduler();
      const afterStop = await createDueSleepingRun();
      await jest.advanceTimersByTimeAsync(5000);
      const stillParked = await db.OrchestrationRun.findByPk(
        afterStop.id as number
      );
      expect(stillParked?.status).toBe('sleeping');
    });

    test('falls back to the default interval for an invalid override', async () => {
      const sleeping = await createDueSleepingRun();

      startOrchestrationScheduler({ intervalMs: 0 });

      // Nothing fires before the default 5s interval elapses.
      await jest.advanceTimersByTimeAsync(4999);
      const parked = await db.OrchestrationRun.findByPk(sleeping.id as number);
      expect(parked?.status).toBe('sleeping');

      // One tick past the default interval → the sweep claims the run.
      await jest.advanceTimersByTimeAsync(1);
      await waitForRunStatus(sleeping.id as number, ['running', 'succeeded']);
    });
  });
});

describe('wakeRun (branch coverage)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no-ops when the run has no wake context', async () => {
    const run = await db.OrchestrationRun.create({
      orchestrationId: transformOrchPk,
      projectId: projectPk,
      status: 'running',
      state: {},
      activeNodes: [],
      artifacts: {},
      input: {},
      wakeContext: null,
    });
    await expect(engineModule.wakeRun({ run })).resolves.toBeUndefined();
    const after = await db.OrchestrationRun.findByPk(run.id as number);
    expect(after?.status).toBe('running');
  });

  test('marks the run failed when its orchestration no longer exists', async () => {
    const run = await createRunWithMissingOrchestration({
      status: 'sleeping',
      wakeAt: new Date(Date.now() - 1000),
      wakeContext: {
        nodeId: 'delay',
        resume: { kind: 'delay', artifact: {} },
      },
    });

    await engineModule.wakeRun({ run });

    // The row was cascade-deleted with its orchestration, but the guard still
    // marks the in-memory instance failed and clears the wake.
    expect(run.status).toBe('failed');
    expect(run.wakeAt).toBeNull();
  });
});

describe('redriveRun (branch coverage)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('marks the run failed and clears the lease when its orchestration is gone', async () => {
    const run = await createRunWithMissingOrchestration({
      status: 'running',
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    await engineModule.redriveRun({ run });

    expect(run.status).toBe('failed');
    expect(run.leaseExpiresAt).toBeNull();
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
    const run = await createRunWithMissingOrchestration({
      status: 'awaiting_input',
    });
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
    // Real orchestration + real run row; only the run-mapping boundary is
    // stubbed (not `db.*`): it resolves for the initial return, then rejects
    // during the background settle so the detached drive's catch is exercised.
    jest
      .spyOn(runHelpersModule, 'mapRunWithIncludes')
      .mockResolvedValueOnce(fakeRun)
      .mockRejectedValueOnce(new Error('map failed during settle'));

    const result = await engineModule.startOrchestrationRun({
      orchestrationPublicId: transformOrchPublicId,
    });

    // Returns the initial run immediately; the background failure is swallowed.
    expect(result).toBe(fakeRun);
    await new Promise<void>((resolve) => {
      return setImmediate(resolve);
    });
  });
});
