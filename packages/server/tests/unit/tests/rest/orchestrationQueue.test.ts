import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { startOrchestrationRun } from 'src/lib/orchestrationEngine';
import { computeNodeIdempotencyKey } from 'src/lib/orchestrationIdempotency';
import { executeAndRecordNode } from 'src/lib/orchestrationNodeRecorder';
import {
  ackRunTask,
  claimRunTasks,
  enqueueRunTask,
  retryRunTask,
} from 'src/lib/orchestrationQueue';
import { drainQueueOnce, handleRunTask } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// The Postgres queue driver + run-scoped idempotency keys (orchestration-queue
// P1). The in-process worker kick is disabled here so tasks are claimed/driven
// explicitly — the auto-drain behaviour is covered by the durable-execution
// tests in orchestrations.test.ts.
describe('Orchestration queue (Postgres driver) + idempotency', () => {
  let userToken: string;
  let adminToken: string;
  let projectId: string;
  let projectPk: number;

  // Fake downstream HTTP service the `tool` node calls. Records every request so
  // the tests can assert the side effect ran exactly once and carried the
  // Idempotency-Key header.
  let echoServer: http.Server;
  let echoServerUrl: string;
  let requests: Array<{ idempotencyKey: string | undefined; body: unknown }>;

  const createOrchestration = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({ ...body, project_id: projectId });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

    const setup = await setupProjectWithUsers({
      prefix: 'orchqueue',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'tools:CreateTool',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectPk = project?.id as number;

    echoServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({
          idempotencyKey:
            typeof req.headers['idempotency-key'] === 'string'
              ? req.headers['idempotency-key']
              : undefined,
          body: raw ? JSON.parse(raw) : null,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      echoServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = echoServer.address() as AddressInfo;
    echoServerUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.ORCHESTRATION_WORKER_DISABLED;
    await new Promise<void>((resolve) => {
      echoServer.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    requests = [];
    // Isolate each test's queue: the worker kick is disabled, so tasks left
    // unacked by a prior test would otherwise be claimable here.
    await db.OrchestrationRunTask.destroy({ where: {}, truncate: true });
  });

  // Creates an http tool pointing at the echo server and returns its public id.
  const createEchoTool = async (): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: `echo-${Math.floor(performance.now())}-${requests.length}`,
        type: 'http',
        execute: { url: `${echoServerUrl}/do`, method: 'POST' },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  // A bare `running` run row to drive node executions against directly.
  const createRunRow = async (orchPk: number) => {
    return db.OrchestrationRun.create({
      orchestrationId: orchPk,
      projectId: projectPk,
      status: 'running',
      state: {},
      activeNodes: [],
      artifacts: {},
      input: {},
      startedAt: new Date(),
    });
  };

  const orchPkOf = async (publicId: string): Promise<number> => {
    const orch = await db.Orchestration.findOne({ where: { publicId } });
    return orch?.id as number;
  };

  describe('start-orchestration-run enqueue', () => {
    test('async start returns queued and executes no node in the request', async () => {
      const orchId = await createOrchestration({
        name: 'Enqueue Only',
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: 'hi',
            state_mapping: { 'state.msg': { var: 'output.result' } },
          },
        ],
        edges: [],
      });

      const run = await startOrchestrationRun({
        orchestrationPublicId: orchId,
        projectId: projectPk,
        projectIds: [projectPk],
        input: {},
      });

      expect(run.status).toBe('queued');
      // No node ran inside the request: the run is still queued and the queue
      // holds exactly one `continue` task for it.
      const runRow = await db.OrchestrationRun.findOne({
        where: { publicId: run.id },
      });
      expect(runRow?.status).toBe('queued');
      const tasks = await db.OrchestrationRunTask.findAll({
        where: { runId: runRow?.id as number },
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].kind).toBe('continue');
    });
  });

  describe('claimRunTasks — SELECT … FOR UPDATE SKIP LOCKED', () => {
    test('two concurrent claimers never claim the same task', async () => {
      const orchId = await createOrchestration({
        name: 'Concurrency',
        nodes: [{ id: 'start', type: 'transform', expression: 1 }],
        edges: [],
      });
      const orchPk = await orchPkOf(orchId);
      const run = await createRunRow(orchPk);

      // Seed a batch of independent tasks for the run.
      const total = 12;
      const seeded = await Promise.all(
        Array.from({ length: total }, () => {
          return enqueueRunTask({ runId: run.id as number, kind: 'continue' });
        })
      );
      const seededIds = seeded.map((t) => {
        return t.id as number;
      });

      const [a, b] = await Promise.all([
        claimRunTasks({ limit: total }),
        claimRunTasks({ limit: total }),
      ]);

      const idsA = a.map((t) => {
        return t.id as number;
      });
      const idsB = b.map((t) => {
        return t.id as number;
      });
      const overlap = idsA.filter((id) => {
        return idsB.includes(id);
      });
      // The two claimers partition the due set — no task is claimed by both.
      expect(overlap).toEqual([]);
      // Every seeded task was claimed exactly once across the two calls.
      const union = new Set([...idsA, ...idsB]);
      for (const id of seededIds) {
        expect(union.has(id)).toBe(true);
      }
    });
  });

  describe('lease expiry redelivery', () => {
    test('a claimed task whose lease expires is redelivered and the run completes with exactly one side effect', async () => {
      const toolId = await createEchoTool();
      const orchId = await createOrchestration({
        name: 'Redelivery',
        nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
        edges: [],
      });

      const started = await startOrchestrationRun({
        orchestrationPublicId: orchId,
        projectId: projectPk,
        projectIds: [projectPk],
        input: {},
      });
      const runPk = (
        await db.OrchestrationRun.findOne({ where: { publicId: started.id } })
      )?.id as number;

      // First worker claims the task (lease set) but "crashes" before acking.
      const [claimed] = await claimRunTasks({ limit: 10 });
      expect(claimed).toBeDefined();

      // Nothing acked it, so once the lease is past it is redelivered. Simulate
      // by claiming again with a `now` past the lease.
      const future = new Date(Date.now() + 10 * 60_000);
      const [redelivered] = await claimRunTasks({ limit: 10, now: future });
      expect(redelivered?.id).toBe(claimed.id);
      expect((redelivered?.attempts as number) >= 2).toBe(true);

      // The redelivering worker drives the run to completion and acks.
      await handleRunTask({ task: redelivered });
      await ackRunTask({ id: redelivered.id as number });

      const settled = await db.OrchestrationRun.findByPk(runPk);
      expect(settled?.status).toBe('succeeded');

      // The side-effecting tool node ran exactly once across the redelivery.
      expect(requests).toHaveLength(1);
      const execs = await db.OrchestrationNodeExecution.findAll({
        where: { runId: runPk, nodeId: 'call' },
      });
      const keyed = execs.filter((e) => {
        return e.idempotencyKey === `${started.id}:call:1`;
      });
      expect(keyed).toHaveLength(1);
      expect(keyed[0].status).toBe('completed');
    });
  });

  describe('run-scoped idempotency keys', () => {
    test('a redelivered node execution reuses the completed key without re-invoking the side effect', async () => {
      const toolId = await createEchoTool();
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Reuse Key',
          nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
          edges: [],
        })
      );
      const run = await createRunRow(orchPk);
      const nodes = [{ id: 'call', type: 'tool' as const, toolId }];

      const first = await executeAndRecordNode({
        nodeId: 'call',
        runRecord: run,
        nodes,
        state: {},
        projectIds: [projectPk],
        traceId: null,
      });
      expect(first.execResult.kind).toBe('artifact');
      expect(requests).toHaveLength(1);

      // Re-running the same (run, node, attempt) finds the completed key and
      // reuses the stored output — the executor is not invoked again.
      const second = await executeAndRecordNode({
        nodeId: 'call',
        runRecord: run,
        nodes,
        state: {},
        projectIds: [projectPk],
        traceId: null,
      });
      expect(requests).toHaveLength(1);
      expect(second.execResult).toEqual(first.execResult);

      // Exactly one node-execution record exists for the key.
      const execs = await db.OrchestrationNodeExecution.findAll({
        where: { runId: run.id as number, nodeId: 'call' },
      });
      expect(execs).toHaveLength(1);
      expect(execs[0].idempotencyKey).toBe(`${run.publicId}:call:1`);
    });

    test('a second attempt runs under a new key and is not suppressed by attempt 1', async () => {
      const toolId = await createEchoTool();
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Retry New Key',
          nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
          edges: [],
        })
      );
      const run = await createRunRow(orchPk);
      const nodes = [{ id: 'call', type: 'tool' as const, toolId }];

      await executeAndRecordNode({
        nodeId: 'call',
        runRecord: run,
        nodes,
        state: {},
        projectIds: [projectPk],
        traceId: null,
      });
      expect(requests).toHaveLength(1);

      // Attempt 2 → a new key `…:2`, so the executor runs for real again.
      await executeAndRecordNode({
        nodeId: 'call',
        runRecord: run,
        nodes,
        state: {},
        projectIds: [projectPk],
        traceId: null,
        retryAttempt: 2,
      });
      expect(requests).toHaveLength(2);

      const keys = (
        await db.OrchestrationNodeExecution.findAll({
          where: { runId: run.id as number, nodeId: 'call' },
        })
      )
        .map((e) => {
          return e.idempotencyKey;
        })
        .sort();
      expect(keys).toEqual([
        `${run.publicId}:call:1`,
        `${run.publicId}:call:2`,
      ]);
    });

    test('an HTTP tool node forwards the raw key as the Idempotency-Key header', async () => {
      const toolId = await createEchoTool();
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Idempotency Header',
          nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
          edges: [],
        })
      );
      const run = await createRunRow(orchPk);

      await executeAndRecordNode({
        nodeId: 'call',
        runRecord: run,
        nodes: [{ id: 'call', type: 'tool' as const, toolId }],
        state: {},
        projectIds: [projectPk],
        traceId: null,
      });

      expect(requests).toHaveLength(1);
      // The header value is the literal run:node:attempt string, unhashed (D7).
      expect(requests[0].idempotencyKey).toBe(`${run.publicId}:call:1`);
    });

    test('a leftover running key from a crash mid-side-effect is taken over and re-executed under the same key', async () => {
      const toolId = await createEchoTool();
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Takeover Running Key',
          nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
          edges: [],
        })
      );
      const run = await createRunRow(orchPk);
      const key = `${run.publicId}:call:1`;

      // Simulate a worker that reserved the key and crashed before completing
      // (a `running` row left behind, no completed output yet).
      await db.OrchestrationNodeExecution.create({
        runId: run.id as number,
        nodeId: 'call',
        nodeType: 'tool',
        attempt: 1,
        status: 'running',
        input: {},
        output: null,
        error: null,
        startedAt: new Date(),
        completedAt: null,
        idempotencyKey: key,
      });

      // The redelivering worker takes over the same key (a unique-violation on
      // insert → reuse the row) and re-executes, since the side effect never
      // completed. This is the honest at-least-once boundary.
      const outcome = await executeAndRecordNode({
        nodeId: 'call',
        runRecord: run,
        nodes: [{ id: 'call', type: 'tool' as const, toolId }],
        state: {},
        projectIds: [projectPk],
        traceId: null,
      });
      expect(outcome.execResult.kind).toBe('artifact');
      expect(requests).toHaveLength(1);

      // Still exactly one row for the key, now completed.
      const execs = await db.OrchestrationNodeExecution.findAll({
        where: { runId: run.id as number, nodeId: 'call' },
      });
      expect(execs).toHaveLength(1);
      expect(execs[0].status).toBe('completed');
      expect(execs[0].idempotencyKey).toBe(key);
    });
  });

  describe('computeNodeIdempotencyKey', () => {
    test('keys side-effecting node types and skips pure / unattributed ones', () => {
      expect(
        computeNodeIdempotencyKey({
          runPublicId: 'orch_run_x',
          nodeId: 'n',
          nodeType: 'tool',
          attempt: 2,
        })
      ).toBe('orch_run_x:n:2');
      // Pure node type → not keyed.
      expect(
        computeNodeIdempotencyKey({
          runPublicId: 'orch_run_x',
          nodeId: 'n',
          nodeType: 'transform',
          attempt: 1,
        })
      ).toBeNull();
      // Missing run id or node type → not keyed.
      expect(
        computeNodeIdempotencyKey({
          runPublicId: null,
          nodeId: 'n',
          nodeType: 'tool',
          attempt: 1,
        })
      ).toBeNull();
      expect(
        computeNodeIdempotencyKey({
          runPublicId: 'orch_run_x',
          nodeId: 'n',
          nodeType: null,
          attempt: 1,
        })
      ).toBeNull();
    });
  });

  describe('retryRunTask', () => {
    test('releases a claimed task and reschedules it for later re-claim', async () => {
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Retry Task',
          nodes: [{ id: 'start', type: 'transform', expression: 1 }],
          edges: [],
        })
      );
      const run = await createRunRow(orchPk);
      const task = await enqueueRunTask({
        runId: run.id as number,
        kind: 'continue',
      });

      const [claimed] = await claimRunTasks({ limit: 5 });
      expect(claimed?.id).toBe(task.id);

      // Release it with a future availableAt — a backoff. It is no longer
      // claimable now, but becomes claimable once availableAt passes.
      const availableAt = new Date(Date.now() + 5 * 60_000);
      await retryRunTask({ id: task.id as number, availableAt });

      const notYet = await claimRunTasks({ limit: 5 });
      expect(
        notYet.some((t) => {
          return t.id === task.id;
        })
      ).toBe(false);

      const later = await claimRunTasks({
        limit: 5,
        now: new Date(availableAt.getTime() + 1000),
      });
      expect(
        later.some((t) => {
          return t.id === task.id;
        })
      ).toBe(true);
    });
  });

  describe('worker loop drains a seeded queue', () => {
    test('drainQueueOnce drives a queued run to completion and acks its task (no HTTP request involved)', async () => {
      const orchId = await createOrchestration({
        name: 'Worker Drain',
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: 'done',
            state_mapping: { 'state.msg': { var: 'output.result' } },
          },
        ],
        edges: [],
      });

      const started = await startOrchestrationRun({
        orchestrationPublicId: orchId,
        projectId: projectPk,
        projectIds: [projectPk],
        input: {},
      });
      const runPk = (
        await db.OrchestrationRun.findOne({ where: { publicId: started.id } })
      )?.id as number;

      // This is the same drain the standalone worker.ts entrypoint runs on a
      // timer — proving the queue is drainable without the API serving requests.
      const claimedCount = await drainQueueOnce();
      expect(claimedCount).toBeGreaterThanOrEqual(1);

      const settled = await db.OrchestrationRun.findByPk(runPk);
      expect(settled?.status).toBe('succeeded');
      expect((settled?.state as Record<string, unknown>).msg).toBe('done');

      // The task was acked (deleted) on completion.
      const remaining = await db.OrchestrationRunTask.findAll({
        where: { runId: runPk },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  describe('handleRunTask dispatch by kind and status', () => {
    test('a wake task drives a sleeping run from its wake context', async () => {
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Wake Dispatch',
          nodes: [
            {
              id: 'pause',
              type: 'delay',
              duration: '1s',
              state_mapping: { 'state.waited': { var: 'output.waited' } },
            },
            {
              id: 'after',
              type: 'transform',
              expression: 'resumed',
              state_mapping: { 'state.after': { var: 'output.result' } },
            },
          ],
          edges: [{ from: 'pause', to: 'after' }],
        })
      );
      // A run parked on the delay node, its wake persisted (as wakeDueRuns
      // leaves it after claiming), with a `wake` task enqueued.
      const run = await db.OrchestrationRun.create({
        orchestrationId: orchPk,
        projectId: projectPk,
        status: 'sleeping',
        state: {},
        activeNodes: ['pause'],
        artifacts: {},
        input: {},
        startedAt: new Date(),
        wakeContext: {
          nodeId: 'pause',
          resume: { kind: 'delay', artifact: { waited: '1s' } },
        },
      });
      await enqueueRunTask({ runId: run.id as number, kind: 'wake' });

      const claimed = await drainQueueOnce();
      expect(claimed).toBeGreaterThanOrEqual(1);

      const settled = await db.OrchestrationRun.findByPk(run.id as number);
      expect(settled?.status).toBe('succeeded');
      expect((settled?.state as Record<string, unknown>).after).toBe('resumed');
    });

    test('a continue task for an orphaned running run re-drives it from the checkpoint', async () => {
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Redrive Dispatch',
          nodes: [
            {
              id: 'start',
              type: 'transform',
              expression: 'hello',
              state_mapping: { 'state.msg': { var: 'output.result' } },
            },
          ],
          edges: [],
        })
      );
      // A `running` run whose driver crashed — the reaper enqueues a `continue`.
      const run = await createRunRow(orchPk);
      await enqueueRunTask({ runId: run.id as number, kind: 'continue' });

      await drainQueueOnce();

      const settled = await db.OrchestrationRun.findByPk(run.id as number);
      expect(settled?.status).toBe('succeeded');
      expect((settled?.state as Record<string, unknown>).msg).toBe('hello');
    });

    test('a task whose run is already terminal is a no-op and is acked', async () => {
      const orchPk = await orchPkOf(
        await createOrchestration({
          name: 'Terminal No-op',
          nodes: [{ id: 'start', type: 'transform', expression: 1 }],
          edges: [],
        })
      );
      const run = await db.OrchestrationRun.create({
        orchestrationId: orchPk,
        projectId: projectPk,
        status: 'cancelled',
        state: {},
        activeNodes: [],
        artifacts: {},
        input: {},
        startedAt: new Date(),
        completedAt: new Date(),
      });
      await enqueueRunTask({ runId: run.id as number, kind: 'continue' });

      await drainQueueOnce();

      // The run is untouched (still cancelled) and the task was acked.
      const after = await db.OrchestrationRun.findByPk(run.id as number);
      expect(after?.status).toBe('cancelled');
      const remaining = await db.OrchestrationRunTask.findAll({
        where: { runId: run.id as number },
      });
      expect(remaining).toHaveLength(0);
    });
  });
});
