import { db } from 'src/db';
import * as eventBusModule from 'src/lib/eventBus';
import { postgresQueueDriver } from 'src/lib/orchestration-queue-drivers/postgresQueueDriver';
import { enqueueRunTask } from 'src/lib/orchestrationQueue';
import {
  reapOrphanedRuns,
  startOrchestrationScheduler,
  stopOrchestrationScheduler,
  wakeDueRuns,
} from 'src/lib/orchestrationScheduler';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The orchestration scheduler and the worker it feeds, driven as the server
 * process drives them: `wakeDueRuns` claims sleeping runs whose wake is due,
 * `reapOrphanedRuns` reclaims `running` runs whose lease expired, each enqueues
 * a task, and `drainQueueOnce` drives it.
 *
 * Runs are started through `POST /orchestration-runs`. The one state no entry
 * point produces is an orphan — a driver that crashed mid-run — so those rows
 * are written directly. The in-process worker kick is disabled so every drive
 * happens at a drain the test makes; each test leaves no run due, so a sweep's
 * count is exact.
 */

type RunInstance = InstanceType<typeof db.OrchestrationRun>;

let userToken: string;
let projectId: string;
let projectPk: number;
let delayOrchestrationId: string;
let chainOrchestrationId: string;
let orchSeq = 0;

const createOrchestration = async (args: {
  nodes: unknown[];
  edges?: unknown[];
}) => {
  orchSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: `Scheduler ${orchSeq}`,
      nodes: args.nodes,
      edges: args.edges ?? [],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const orchestrationPk = async (publicId: string): Promise<number> => {
  const orchestration = await db.Orchestration.findOne({ where: { publicId } });
  return orchestration!.id as number;
};

const runByPublicId = async (publicId: string): Promise<RunInstance> => {
  return (await db.OrchestrationRun.findOne({ where: { publicId } }))!;
};

const startInBackground = async (orchestrationId: string) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestration-runs')
    .send({ orchestration_id: orchestrationId, input: {} });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('queued');
  return runByPublicId(res.body.id as string);
};

const reload = async (run: RunInstance): Promise<RunInstance> => {
  return (await db.OrchestrationRun.findByPk(run.id as number))!;
};

const tasksOf = (run: RunInstance) => {
  return db.OrchestrationRunTask.count({
    where: { orchestrationRunId: run.id as number },
  });
};

/**
 * A sweep enqueues its task detached from the claim, so the drain waits for
 * the task row rather than racing it.
 */
const drainOnceEnqueued = async (run: RunInstance) => {
  for (let i = 0; i < 1000; i += 1) {
    if ((await tasksOf(run)) > 0) break;
  }
  expect(await drainQueueOnce()).toBe(1);
};

/** A run started in the background and parked on its 1s `delay` node. */
const parkSleeping = async (): Promise<RunInstance> => {
  const run = await startInBackground(delayOrchestrationId);
  expect(await drainQueueOnce()).toBe(1);
  const parked = await reload(run);
  expect(parked.status).toBe('sleeping');
  return parked;
};

/** A `running` run whose lease expired: its driver crashed mid-flight. */
const createOrphan = async (args: {
  orchestrationId: string;
  artifacts?: Record<string, unknown>;
}) => {
  return db.OrchestrationRun.create({
    orchestrationId: await orchestrationPk(args.orchestrationId),
    orchestrationVersion: 1,
    projectId: projectPk,
    status: 'running',
    state: {},
    activeNodes: [],
    artifacts: args.artifacts ?? {},
    input: {},
    startedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() - 60_000),
  });
};

const AFTER_A_WAKE = () => {
  return new Date(Date.now() + 60_000);
};

const executedNodes = async (run: RunInstance): Promise<string[]> => {
  const executions = await db.OrchestrationNodeExecution.findAll({
    where: { orchestrationRunId: run.id as number },
    order: [['id', 'ASC']],
  });
  // A node the drive never reached is recorded as `skipped` when the run
  // settles; only the others actually executed.
  return executions
    .filter((execution) => {
      return execution.status !== 'skipped';
    })
    .map((execution) => {
      return execution.nodeId;
    });
};

beforeAll(async () => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

  const setup = await setupProjectWithUsers({
    prefix: 'orchsched',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:StartRun',
      'orchestrations:GetRun',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
  const project = await db.Project.findOne({ where: { publicId: projectId } });
  projectPk = project!.id as number;

  delayOrchestrationId = await createOrchestration({
    nodes: [
      {
        id: 'delay',
        type: 'delay',
        duration: '1s',
        state_mapping: { 'state.waited': { var: 'output.waited' } },
      },
      {
        id: 'after',
        type: 'transform',
        expression: 'done',
        state_mapping: { 'state.after': { var: 'output.result' } },
      },
    ],
    edges: [{ from: 'delay', to: 'after' }],
  });

  chainOrchestrationId = await createOrchestration({
    nodes: ['a', 'b', 'c'].map((id) => {
      return {
        id,
        type: 'transform',
        expression: id.toUpperCase(),
        state_mapping: { [`state.${id}`]: { var: 'output.result' } },
      };
    }),
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  });
});

afterAll(() => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
});

afterEach(() => {
  jest.restoreAllMocks();
  stopOrchestrationScheduler();
  delete process.env.ORCHESTRATION_RUN_LEASE_TTL_MS;
  delete process.env.ORCHESTRATION_SCHEDULER_INTERVAL_MS;
});

describe('wakeDueRuns', () => {
  test('claims nothing when no wake is due', async () => {
    expect(await wakeDueRuns({ now: new Date(0) })).toBe(0);
  });

  test('a query that fails counts as nothing due', async () => {
    // An invalid instant fails the `wakeAt <= now` query at the database.
    expect(await wakeDueRuns({ now: new Date('not-a-date') })).toBe(0);
  });

  test('claims a due run and the worker drives it from its wake', async () => {
    const run = await parkSleeping();

    expect(await wakeDueRuns({ now: AFTER_A_WAKE() })).toBe(1);
    const claimed = await reload(run);
    expect(claimed.status).toBe('running');
    expect(claimed.wakeAt).toBeNull();

    await drainOnceEnqueued(run);
    const settled = await reload(run);
    expect(settled.status).toBe('succeeded');
    expect(settled.state).toMatchObject({ waited: '1s', after: 'done' });
  });

  test('overlapping ticks claim a due run exactly once', async () => {
    const run = await parkSleeping();

    const [first, second] = await Promise.all([
      wakeDueRuns({ now: AFTER_A_WAKE() }),
      wakeDueRuns({ now: AFTER_A_WAKE() }),
    ]);
    expect(first + second).toBe(1);

    await drainOnceEnqueued(run);
    expect(await tasksOf(run)).toBe(0);
    expect((await reload(run)).status).toBe('succeeded');
  });

  test('a claimed run keeps its claim when its task cannot be enqueued', async () => {
    const run = await parkSleeping();
    jest
      .spyOn(postgresQueueDriver, 'enqueue')
      .mockRejectedValueOnce(new Error('queue unavailable'));

    expect(await wakeDueRuns({ now: AFTER_A_WAKE() })).toBe(1);

    // The rejection is logged inside the sweep; the claim already landed.
    const claimed = await reload(run);
    expect(claimed.status).toBe('running');
    expect(claimed.wakeAt).toBeNull();
    expect(await tasksOf(run)).toBe(0);
    await claimed.update({ status: 'cancelled', leaseExpiresAt: null });
  });

  test('a woken run acquires a lease of ORCHESTRATION_RUN_LEASE_TTL_MS from the wall clock', async () => {
    const run = await parkSleeping();
    process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = '1234';

    const before = Date.now();
    expect(await wakeDueRuns({ now: AFTER_A_WAKE() })).toBe(1);
    const after = Date.now();

    const lease = (await reload(run)).leaseExpiresAt!.getTime();
    expect(lease).toBeGreaterThanOrEqual(before + 1234);
    expect(lease).toBeLessThanOrEqual(after + 1234);
    await drainOnceEnqueued(run);
  });
});

describe('reapOrphanedRuns', () => {
  test('claims nothing when no lease has expired', async () => {
    expect(await reapOrphanedRuns({ now: new Date(0) })).toBe(0);
  });

  test('a query that fails counts as nothing orphaned', async () => {
    // An invalid instant fails the `leaseExpiresAt < now` query at the database.
    expect(await reapOrphanedRuns({ now: new Date('not-a-date') })).toBe(0);
  });

  test('leaves a running run whose lease is still fresh', async () => {
    const healthy = await createOrphan({
      orchestrationId: chainOrchestrationId,
    });
    await healthy.update({ leaseExpiresAt: new Date(Date.now() + 60_000) });

    expect(await reapOrphanedRuns({ now: new Date() })).toBe(0);
    expect((await reload(healthy)).status).toBe('running');
    await healthy.update({ status: 'cancelled', leaseExpiresAt: null });
  });

  test('extends a reclaimed lease by ORCHESTRATION_RUN_LEASE_TTL_MS from the sweep instant', async () => {
    const orphan = await createOrphan({
      orchestrationId: chainOrchestrationId,
    });
    const now = new Date();

    process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = '1234';
    expect(await reapOrphanedRuns({ now })).toBe(1);
    expect((await reload(orphan)).leaseExpiresAt!.getTime()).toBe(
      now.getTime() + 1234
    );
    await drainOnceEnqueued(orphan);
  });

  test.each(['', 'not-a-number', '-5'])(
    'a lease TTL of %j falls back to ten minutes',
    async (configured) => {
      const orphan = await createOrphan({
        orchestrationId: chainOrchestrationId,
      });
      const now = new Date();

      process.env.ORCHESTRATION_RUN_LEASE_TTL_MS = configured;
      expect(await reapOrphanedRuns({ now })).toBe(1);
      expect((await reload(orphan)).leaseExpiresAt!.getTime()).toBe(
        now.getTime() + 600_000
      );
      await drainOnceEnqueued(orphan);
    }
  );

  // The redrive frontier: every node with no artifact yet whose predecessors
  // all have one, so nothing that completed before the crash runs again.
  test.each([
    ['nothing checkpointed restarts from the start node', {}, ['a', 'b', 'c']],
    [
      'a checkpointed node resumes at its successor',
      { a: { result: 'A' } },
      ['b', 'c'],
    ],
    [
      'every node checkpointed settles without executing',
      { a: { result: 'A' }, b: { result: 'B' }, c: { result: 'C' } },
      [],
    ],
  ])('%s', async (_label, artifacts, expected) => {
    const orphan = await createOrphan({
      orchestrationId: chainOrchestrationId,
      artifacts,
    });

    expect(await reapOrphanedRuns({ now: new Date() })).toBe(1);
    await drainOnceEnqueued(orphan);

    expect((await reload(orphan)).status).toBe('succeeded');
    expect(await executedNodes(orphan)).toEqual(expected);
  });

  test('an uncompleted parallel start branch is re-driven on its own', async () => {
    const parallel = await createOrchestration({
      nodes: [
        { id: 'x', type: 'transform', expression: 'X' },
        { id: 'y', type: 'transform', expression: 'Y' },
      ],
    });
    const orphan = await createOrphan({
      orchestrationId: parallel,
      artifacts: { x: { result: 'X' } },
    });

    expect(await reapOrphanedRuns({ now: new Date() })).toBe(1);
    await drainOnceEnqueued(orphan);

    expect((await reload(orphan)).status).toBe('succeeded');
    expect(await executedNodes(orphan)).toEqual(['y']);
  });
});

describe('startOrchestrationScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Polls a run row without timers, so it works under the fake clock too. */
  const waitForClaim = async (run: RunInstance) => {
    for (let i = 0; i < 3000; i += 1) {
      if ((await reload(run)).status === 'running') return;
    }
    throw new Error(`run ${run.id} was never claimed`);
  };

  /**
   * The claim enqueues its task detached; it has to land before the fake clock
   * is uninstalled, which drops whatever timers the write still waits on.
   */
  const waitForTask = async (run: RunInstance) => {
    for (let i = 0; i < 3000; i += 1) {
      if ((await tasksOf(run)) > 0) return;
    }
    throw new Error(`run ${run.id} never had a task enqueued`);
  };

  test('runs both sweeps on each tick, once however often it is started, and stops', async () => {
    const sleeping = await parkSleeping();
    const orphan = await createOrphan({
      orchestrationId: chainOrchestrationId,
    });
    jest.useFakeTimers({ now: Date.now() });

    startOrchestrationScheduler({ intervalMs: 5000 });
    startOrchestrationScheduler({ intervalMs: 5000 });
    await jest.advanceTimersByTimeAsync(5000);

    await waitForClaim(sleeping);
    await waitForTask(sleeping);
    await waitForTask(orphan);

    // Stopped, nothing ticks on — including a second timer, had the second
    // start created one. A run already due when the clock moves on stays
    // parked; it is written directly because the API's own park would need
    // the real clock.
    stopOrchestrationScheduler();
    const afterStop = await db.OrchestrationRun.create({
      orchestrationId: await orchestrationPk(delayOrchestrationId),
      orchestrationVersion: 1,
      projectId: projectPk,
      status: 'sleeping',
      state: {},
      activeNodes: ['delay'],
      artifacts: {},
      input: {},
      startedAt: new Date(),
      wakeAt: new Date(Date.now() - 1000),
      wakeContext: {
        nodeId: 'delay',
        resume: { kind: 'delay', artifact: { waited: '1s' } },
      },
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect((await reload(afterStop)).status).toBe('sleeping');

    jest.useRealTimers();
    // The tasks were stamped available on the fake clock, ahead of the real one.
    expect(await drainQueueOnce({ now: AFTER_A_WAKE() })).toBe(2);
    expect(await wakeDueRuns({ now: AFTER_A_WAKE() })).toBe(1);
    await drainOnceEnqueued(afterStop);
  });

  // Each case holds the clock just short of one interval and then past it:
  // parked with its wake 1s out, the run is left alone by the sweep at start,
  // so only a tick on the interval under test claims it.
  test.each([
    // Longer than the default, so a scheduler ignoring the variable would
    // already have ticked at the first check.
    ['ORCHESTRATION_SCHEDULER_INTERVAL_MS', undefined, '8000', 5000, 3000],
    // An override of 0 used as-is would tick before the first check.
    ['the default when the override is unusable', 0, undefined, 4999, 1],
  ])(
    'ticks on %s',
    async (_label, intervalMs, configured, quietMs, toTickMs) => {
      if (configured) {
        process.env.ORCHESTRATION_SCHEDULER_INTERVAL_MS = configured;
      }
      const run = await parkSleeping();
      jest.useFakeTimers({ now: Date.now() });

      startOrchestrationScheduler(
        intervalMs === undefined ? undefined : { intervalMs }
      );
      await jest.advanceTimersByTimeAsync(quietMs);
      expect((await reload(run)).status).toBe('sleeping');

      await jest.advanceTimersByTimeAsync(toTickMs);
      await waitForClaim(run);
      await waitForTask(run);

      stopOrchestrationScheduler();
      jest.useRealTimers();
      // The task was stamped available on the fake clock, ahead of the real one.
      expect(await drainQueueOnce({ now: AFTER_A_WAKE() })).toBe(1);
    }
  );
});

describe('the worker', () => {
  test('a wake redelivered after its context was consumed is acked without driving', async () => {
    const run = await createOrphan({ orchestrationId: chainOrchestrationId });
    await run.update({ leaseExpiresAt: new Date(Date.now() + 60_000) });
    await enqueueRunTask({
      orchestrationRunId: run.id as number,
      kind: 'wake',
    });

    expect(await drainQueueOnce()).toBe(1);

    expect((await reload(run)).status).toBe('running');
    expect(await executedNodes(run)).toEqual([]);
    expect(await tasksOf(run)).toBe(0);
    await run.update({ status: 'cancelled', leaseExpiresAt: null });
  });

  test('a claim that fails drains nothing', async () => {
    jest
      .spyOn(postgresQueueDriver, 'claim')
      .mockRejectedValueOnce(new Error('queue unavailable'));

    expect(await drainQueueOnce()).toBe(0);
  });

  test('a drive that throws leaves its task for redelivery and the start answers queued', async () => {
    // A stored graph whose `nodes` is not an array: the start is accepted,
    // and the worker's drive throws on it.
    const corrupt = await db.Orchestration.create({
      projectId: projectPk,
      name: 'Corrupt Graph',
      nodes: {},
      edges: [],
    });
    const run = await startInBackground(corrupt.publicId as string);

    expect(await drainQueueOnce()).toBe(1);

    expect(await tasksOf(run)).toBe(1);
    await db.OrchestrationRunTask.destroy({
      where: { orchestrationRunId: run.id as number },
    });
    await (await reload(run)).update({ status: 'cancelled' });
  });
});

describe('run lifecycle events', () => {
  test('a lookup failure drops the event and leaves the run unaffected', async () => {
    const events: eventBusModule.SoatEvent[] = [];
    const capture = (event: eventBusModule.SoatEvent) => {
      events.push(event);
    };
    eventBusModule.eventBus.on('soat:event', capture);
    jest
      .spyOn(eventBusModule, 'resolveProjectPublicId')
      .mockRejectedValueOnce(new Error('database unavailable'));
    try {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: chainOrchestrationId,
          input: {},
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('succeeded');
      // The succeeded event resolves its project id asynchronously; each
      // database round trip yields until it lands.
      const row = await runByPublicId(res.body.id as string);
      const settled = () => {
        return events.some((event) => {
          return (
            event.resourceId === res.body.id &&
            event.type === 'orchestration_runs.succeeded'
          );
        });
      };
      for (let i = 0; i < 1000 && !settled(); i += 1) {
        await reload(row);
      }
      const types = events
        .filter((event) => {
          return event.resourceId === res.body.id;
        })
        .map((event) => {
          return event.type;
        });
      expect(types).toEqual(['orchestration_runs.succeeded']);
    } finally {
      eventBusModule.eventBus.off('soat:event', capture);
    }
  });
});
