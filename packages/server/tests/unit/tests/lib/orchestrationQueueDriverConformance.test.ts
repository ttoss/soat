import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { db } from 'src/db';
import {
  getOrchestrationQueueDriver,
  queueDriverName,
  resetOrchestrationQueueDriver,
} from 'src/lib/orchestration-queue-drivers';
import { postgresQueueDriver } from 'src/lib/orchestration-queue-drivers/postgresQueueDriver';
import {
  createSqsQueueDriver,
  parseSqsTaskBody,
  sqsDelaySeconds,
} from 'src/lib/orchestration-queue-drivers/sqsQueueDriver';
import type {
  ClaimedTask,
  OrchestrationQueueDriver,
} from 'src/lib/orchestration-queue-drivers/types';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { type FakeSqs, startFakeSqs } from '../../fixtures/fakeSqs';
import { authenticatedTestClient } from '../../testClient';

// Every driver must behave identically for the four operations the durable
// runtime depends on, so a deployment can swap `ORCHESTRATION_QUEUE_DRIVER`
// without the engine, scheduler or worker noticing.
//
// A `lib/` test by the keep-list rule: the SQS driver has no entry point
// reachable in CI, and the point is to compare two implementations of one
// contract directly. Its side runs the real driver and AWS client against a
// local fake, so command serialization is exercised for real.

const LEASE_TTL_MS = 60_000;

/**
 * Everything the suite needs to drive one driver: the driver itself, a way to
 * mint a valid run reference (the Postgres driver has a real foreign key), a
 * virtual clock, and a per-test reset.
 *
 * The clock always starts at real time on `reset()`, so a test enqueues first
 * and only then advances — that keeps `availableAt` arithmetic identical for a
 * driver that takes `now` as a parameter (Postgres) and one that reads its
 * backend's clock (SQS).
 */
type DriverHarness = {
  name: string;
  driver: OrchestrationQueueDriver;
  newRunId: () => Promise<number>;
  now: () => Date;
  claim: (limit: number) => Promise<ClaimedTask[]>;
  advance: (ms: number) => void;
  reset: () => Promise<void>;
};

describe('Orchestration queue driver conformance', () => {
  let projectPk: number;
  let orchestrationPk: number;
  let fakeSqs: FakeSqs;
  let harnesses: DriverHarness[];

  beforeAll(async () => {
    process.env.ORCHESTRATION_TASK_LEASE_TTL_MS = String(LEASE_TTL_MS);
    // Nothing may drain the queue behind the suite's back: every claim here is
    // explicit, so the in-process worker kick stays off.
    process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

    const setup = await setupProjectWithUsers({
      prefix: 'queuedrivers',
      policyActions: ['orchestrations:CreateOrchestration'],
      createNoPermUser: false,
    });
    const project = await db.Project.findOne({
      where: { publicId: setup.projectId },
    });
    projectPk = project?.id as number;

    const created = await authenticatedTestClient(setup.userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: setup.projectId,
        name: 'queue-driver-conformance',
        nodes: [{ id: 'noop', type: 'transform', expression: 1 }],
        edges: [],
      });
    expect(created.status).toBe(201);
    const orchestration = await db.Orchestration.findOne({
      where: { publicId: created.body.id },
    });
    orchestrationPk = orchestration?.id as number;

    fakeSqs = await startFakeSqs();

    const newRunRow = async (): Promise<number> => {
      const run = await db.OrchestrationRun.create({
        orchestrationId: orchestrationPk,
        projectId: projectPk,
        status: 'queued',
        state: {},
        activeNodes: [],
        artifacts: {},
        input: {},
      });
      return run.id as number;
    };

    let postgresOffsetMs = 0;
    const postgresHarness: DriverHarness = {
      name: 'postgres',
      driver: postgresQueueDriver,
      newRunId: newRunRow,
      now: () => {
        return new Date(Date.now() + postgresOffsetMs);
      },
      claim: (limit) => {
        return postgresQueueDriver.claim({
          limit,
          now: new Date(Date.now() + postgresOffsetMs),
        });
      },
      advance: (ms) => {
        postgresOffsetMs += ms;
      },
      reset: async () => {
        postgresOffsetMs = 0;
        await db.OrchestrationRunTask.destroy({ where: {}, truncate: true });
      },
    };

    const sqsDriver = createSqsQueueDriver({
      client: new SQSClient({
        region: 'us-east-1',
        endpoint: fakeSqs.url,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
      queueUrl: fakeSqs.queueUrl,
    });
    const sqsHarness: DriverHarness = {
      name: 'sqs',
      driver: sqsDriver,
      // SQS carries only the run reference; no foreign key to satisfy. A real
      // row is still used so both harnesses exercise identical payloads.
      newRunId: newRunRow,
      now: () => {
        return new Date();
      },
      claim: (limit) => {
        return sqsDriver.claim({ limit });
      },
      advance: (ms) => {
        fakeSqs.advance(ms);
      },
      reset: async () => {
        fakeSqs.reset();
      },
    };

    harnesses = [postgresHarness, sqsHarness];
  });

  afterAll(async () => {
    delete process.env.ORCHESTRATION_TASK_LEASE_TTL_MS;
    delete process.env.ORCHESTRATION_WORKER_DISABLED;
    resetOrchestrationQueueDriver();
    await fakeSqs.close();
  });

  // One `describe.each` over the harnesses: identical assertions, two backends.
  describe.each([
    ['postgres', 0],
    ['sqs', 1],
  ])('%s driver', (_driverName, index) => {
    const h = (): DriverHarness => {
      return harnesses[index];
    };

    beforeEach(async () => {
      await h().reset();
    });

    test('an enqueued task is claimed with its run reference and kind', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });

      const [task] = await h().claim(10);

      expect(task).toBeDefined();
      expect(task.orchestrationRunId).toBe(orchestrationRunId);
      expect(task.kind).toBe('continue');
      expect(task.attempts).toBe(1);
      expect(typeof task.id).toBe('string');
      expect(typeof task.handle).toBe('string');
    });

    test('claiming an empty queue returns no tasks', async () => {
      expect(await h().claim(10)).toEqual([]);
    });

    test('claim never returns more than the requested limit', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });

      expect(await h().claim(2)).toHaveLength(2);
    });

    test('a claimed task is not handed out again while its lease is valid', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });

      expect(await h().claim(10)).toHaveLength(1);
      expect(await h().claim(10)).toHaveLength(0);
    });

    test('an unacked task is redelivered once its lease expires, with attempts bumped', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'wake' });

      const [first] = await h().claim(10);
      expect(first.attempts).toBe(1);

      h().advance(LEASE_TTL_MS + 1000);

      const [redelivered] = await h().claim(10);
      expect(redelivered).toBeDefined();
      expect(redelivered.orchestrationRunId).toBe(orchestrationRunId);
      expect(redelivered.kind).toBe('wake');
      expect(redelivered.attempts).toBe(2);
    });

    test('an acked task is never delivered again', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });

      const [task] = await h().claim(10);
      await h().driver.ack({ task });

      h().advance(LEASE_TTL_MS + 1000);
      expect(await h().claim(10)).toHaveLength(0);
    });

    test('a task enqueued for the future is not claimable until then', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({
        orchestrationRunId,
        kind: 'wake',
        availableAt: new Date(h().now().getTime() + 60_000),
      });

      expect(await h().claim(10)).toHaveLength(0);

      h().advance(61_000);
      expect(await h().claim(10)).toHaveLength(1);
    });

    test('retry parks a delivered task and returns it after the backoff', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });

      const [task] = await h().claim(10);
      await h().driver.retry({
        task,
        availableAt: new Date(h().now().getTime() + 30_000),
      });

      expect(await h().claim(10)).toHaveLength(0);

      h().advance(31_000);
      const [again] = await h().claim(10);
      expect(again).toBeDefined();
      expect(again.orchestrationRunId).toBe(orchestrationRunId);
    });

    test('stats report the active driver and its queued/claimed depth', async () => {
      const orchestrationRunId = await h().newRunId();
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });
      await h().driver.enqueue({ orchestrationRunId, kind: 'continue' });

      const queued = await h().driver.stats();
      expect(queued.driver).toBe(h().name);
      expect(queued.queueDepth).toBe(2);
      expect(queued.claimedTasks).toBe(0);
      expect(queued.claimLatencyMs.windowSeconds).toBe(300);

      await h().claim(2);

      const claimed = await h().driver.stats();
      expect(claimed.queueDepth).toBe(0);
      expect(claimed.claimedTasks).toBe(2);
    });
  });

  // Behaviour that is deliberately *not* uniform, asserted so the difference
  // stays visible and documented rather than surprising an operator.
  describe('documented driver differences', () => {
    test('only the Postgres driver enforces per-project concurrency', () => {
      expect(postgresQueueDriver.enforcesProjectConcurrency).toBe(true);
      expect(harnesses[1].driver.enforcesProjectConcurrency).toBe(false);
    });
  });

  describe('SQS message decoding', () => {
    test.each([
      ['not json', 'nope'],
      ['a json scalar', '3'],
      ['a missing run id', JSON.stringify({ kind: 'continue' })],
      [
        'a non-numeric run id',
        JSON.stringify({ orchestrationRunId: 'x', kind: 'wake' }),
      ],
      [
        'an unknown kind',
        JSON.stringify({ orchestrationRunId: 1, kind: 'explode' }),
      ],
      ['an empty body', undefined],
    ])('rejects %s', (_label, raw) => {
      expect(parseSqsTaskBody(raw)).toBeNull();
    });

    test('accepts a well-formed body', () => {
      expect(
        parseSqsTaskBody(
          JSON.stringify({ orchestrationRunId: 7, kind: 'resume' })
        )
      ).toEqual({ orchestrationRunId: 7, kind: 'resume' });
    });

    test('an undecodable message is dropped rather than redelivered forever', async () => {
      await harnesses[1].reset();
      const sqs = new SQSClient({
        region: 'us-east-1',
        endpoint: fakeSqs.url,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      // Publish a message no driver version could parse, as a stray producer
      // (or an older format) would.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: fakeSqs.queueUrl,
          MessageBody: 'definitely-not-json',
        })
      );

      expect(await harnesses[1].driver.claim({ limit: 10 })).toEqual([]);
      expect(fakeSqs.size()).toBe(0);
    });
  });

  describe('sqsDelaySeconds', () => {
    const now = new Date('2026-07-26T00:00:00.000Z');

    test('is zero without an availableAt', () => {
      expect(sqsDelaySeconds({ now })).toBe(0);
    });

    test('is zero for a time already past', () => {
      expect(
        sqsDelaySeconds({ now, availableAt: new Date(now.getTime() - 5_000) })
      ).toBe(0);
    });

    test('rounds a sub-second wait up to a whole second', () => {
      expect(
        sqsDelaySeconds({ now, availableAt: new Date(now.getTime() + 1_200) })
      ).toBe(2);
    });

    test('clamps to the 15-minute SQS maximum', () => {
      expect(
        sqsDelaySeconds({
          now,
          availableAt: new Date(now.getTime() + 3_600_000),
        })
      ).toBe(900);
    });
  });

  describe('driver selection', () => {
    afterEach(() => {
      delete process.env.ORCHESTRATION_QUEUE_DRIVER;
      delete process.env.ORCHESTRATION_QUEUE_SQS_QUEUE_URL;
      resetOrchestrationQueueDriver();
    });

    test('defaults to the Postgres driver when unset', () => {
      delete process.env.ORCHESTRATION_QUEUE_DRIVER;
      resetOrchestrationQueueDriver();
      expect(queueDriverName()).toBe('postgres');
      expect(getOrchestrationQueueDriver().name).toBe('postgres');
    });

    test('selects the SQS driver from the environment', () => {
      process.env.ORCHESTRATION_QUEUE_DRIVER = 'sqs';
      process.env.ORCHESTRATION_QUEUE_SQS_QUEUE_URL = fakeSqs.queueUrl;
      resetOrchestrationQueueDriver();
      expect(getOrchestrationQueueDriver().name).toBe('sqs');
    });

    test('caches the driver until it is reset', () => {
      resetOrchestrationQueueDriver();
      const first = getOrchestrationQueueDriver();
      expect(getOrchestrationQueueDriver()).toBe(first);
    });

    test('rejects an unknown driver name instead of falling back', () => {
      process.env.ORCHESTRATION_QUEUE_DRIVER = 'kafka';
      resetOrchestrationQueueDriver();
      expect(() => {
        return getOrchestrationQueueDriver();
      }).toThrow(/Unknown ORCHESTRATION_QUEUE_DRIVER/);
    });

    test('the SQS driver refuses to run without a queue URL', async () => {
      process.env.ORCHESTRATION_QUEUE_DRIVER = 'sqs';
      delete process.env.ORCHESTRATION_QUEUE_SQS_QUEUE_URL;
      resetOrchestrationQueueDriver();
      await expect(
        getOrchestrationQueueDriver().enqueue({
          orchestrationRunId: 1,
          kind: 'continue',
        })
      ).rejects.toThrow(/ORCHESTRATION_QUEUE_SQS_QUEUE_URL/);
    });
  });
});
