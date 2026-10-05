import { db } from 'src/db';
import { reapOrphanedRuns, wakeDueRuns } from 'src/lib/orchestrationScheduler';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A run executes the graph it started on, not the graph the orchestration holds
 * now. Each test parks or queues a run on v1, rewires the orchestration to v2
 * with `PATCH /orchestrations/:id`, and then drives the run through one
 * execution entry point:
 *
 * | Entry point | Driven by |
 * |---|---|
 * | first drive | the worker draining a queued run |
 * | wake | the scheduler's `wakeDueRuns` |
 * | redrive | the reaper's `reapOrphanedRuns` |
 * | resume | `POST /orchestration-runs/:id/human-input` and `/resume` |
 *
 * Every graph's last node writes a marker into state, so the assertion names
 * *which topology ran* rather than merely that the run finished. The in-process
 * worker kick is disabled so each drive happens at a drain the test makes.
 */

type RunBody = {
  id: string;
  status: string;
  state: Record<string, unknown>;
  orchestration_version: number;
};

let userToken: string;
let projectId: string;
let projectPk: number;
let orchSeq = 0;

/** The node that reports which graph executed, via its state mapping. */
const markerNode = (marker: string) => {
  return {
    id: 'answer',
    type: 'transform',
    expression: marker,
    state_mapping: { 'state.answer': { var: 'output.result' } },
  };
};

const createOrchestration = async (nodes: unknown[], edges: unknown[]) => {
  orchSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({ project_id: projectId, name: `Pinning ${orchSeq}`, nodes, edges });
  expect(res.status).toBe(201);
  expect(res.body.version).toBe(1);
  return res.body.id as string;
};

/** Rewires the orchestration, bumping it to v2. */
const rewire = async (args: {
  orchestrationId: string;
  nodes: unknown[];
  edges: unknown[];
}) => {
  const res = await authenticatedTestClient(userToken)
    .patch(`/api/v1/orchestrations/${args.orchestrationId}`)
    .send({ nodes: args.nodes, edges: args.edges });
  expect(res.status).toBe(200);
  expect(res.body.version).toBe(2);
};

const orchestrationPk = async (publicId: string): Promise<number> => {
  const orchestration = await db.Orchestration.findOne({ where: { publicId } });
  return orchestration!.id as number;
};

const startRun = async (args: { orchestrationId: string; wait: boolean }) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestration-runs')
    .send({
      orchestration_id: args.orchestrationId,
      input: {},
      wait: args.wait,
    });
  expect(res.status).toBe(201);
  return res.body as RunBody;
};

const getRun = async (runId: string): Promise<RunBody> => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/orchestration-runs/${runId}`
  );
  expect(res.status).toBe(200);
  return res.body as RunBody;
};

const runPk = async (runId: string): Promise<number> => {
  const run = await db.OrchestrationRun.findOne({ where: { publicId: runId } });
  return run!.id as number;
};

/**
 * A sweep enqueues its task detached from the claim, so the drain waits for
 * the task row rather than racing it.
 */
const drainOnceEnqueued = async (runId: string) => {
  const orchestrationRunId = await runPk(runId);
  for (let i = 0; i < 1000; i += 1) {
    const tasks = await db.OrchestrationRunTask.count({
      where: { orchestrationRunId },
    });
    if (tasks > 0) break;
  }
  expect(await drainQueueOnce()).toBe(1);
};

beforeAll(async () => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

  const setup = await setupProjectWithUsers({
    prefix: 'orchpin',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:UpdateOrchestration',
      'orchestrations:StartRun',
      'orchestrations:GetRun',
      'orchestrations:PauseRun',
      'orchestrations:ResumeRun',
      'orchestrations:SubmitHumanInput',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
  const project = await db.Project.findOne({ where: { publicId: projectId } });
  projectPk = project!.id as number;
});

afterAll(() => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
});

describe('a run woken from `sleeping`', () => {
  const DELAY_NODE = {
    id: 'delay',
    type: 'delay',
    duration: '1s',
    state_mapping: { 'state.waited': { var: 'output.waited' } },
  };
  const EDGES = [{ from: 'delay', to: 'answer' }];

  /** Parks a v1 run on its delay, then lets `edit` run before the wake. */
  const sleepThenWake = async (args: {
    edit: (ids: { orchestrationId: string; runId: string }) => Promise<void>;
  }) => {
    const orchestrationId = await createOrchestration(
      [DELAY_NODE, markerNode('v1')],
      EDGES
    );
    const run = await startRun({ orchestrationId, wait: false });
    expect(await drainQueueOnce()).toBe(1);
    expect((await getRun(run.id)).status).toBe('sleeping');

    await args.edit({ orchestrationId, runId: run.id });

    expect(await wakeDueRuns({ now: new Date(Date.now() + 60_000) })).toBe(1);
    await drainOnceEnqueued(run.id);
    return getRun(run.id);
  };

  test('executes the graph it went to sleep on, not the edited one', async () => {
    const settled = await sleepThenWake({
      edit: ({ orchestrationId }) => {
        return rewire({
          orchestrationId,
          nodes: [DELAY_NODE, markerNode('v2')],
          edges: EDGES,
        });
      },
    });

    expect(settled.status).toBe('succeeded');
    expect(settled.state.answer).toBe('v1');
    expect(settled.orchestration_version).toBe(1);
  });

  test('still runs a node the edit deleted', async () => {
    // With the successor gone from the live graph, an unpinned run would
    // resolve no next node and settle having skipped the work it exists for.
    const settled = await sleepThenWake({
      edit: ({ orchestrationId }) => {
        return rewire({ orchestrationId, nodes: [DELAY_NODE], edges: [] });
      },
    });

    expect(settled.status).toBe('succeeded');
    expect(settled.state.answer).toBe('v1');
  });

  // The two fallbacks no entry point produces — a run predating pinning, and an
  // archive row deleted out of band — so each perturbs one row. Both degrade
  // to the live graph rather than strand the run.
  test('a run with no pinned version executes the live graph', async () => {
    const settled = await sleepThenWake({
      edit: async ({ orchestrationId, runId }) => {
        await db.OrchestrationRun.update(
          { orchestrationVersion: null },
          { where: { publicId: runId } }
        );
        await rewire({
          orchestrationId,
          nodes: [DELAY_NODE, markerNode('v2')],
          edges: EDGES,
        });
      },
    });

    expect(settled.status).toBe('succeeded');
    expect(settled.state.answer).toBe('v2');
  });

  test('a pinned version whose archive is gone executes the live graph', async () => {
    const settled = await sleepThenWake({
      edit: async ({ orchestrationId }) => {
        await rewire({
          orchestrationId,
          nodes: [DELAY_NODE, markerNode('v2')],
          edges: EDGES,
        });
        await db.OrchestrationVersion.destroy({
          where: {
            orchestrationId: await orchestrationPk(orchestrationId),
            version: 1,
          },
        });
      },
    });

    expect(settled.status).toBe('succeeded');
    expect(settled.state.answer).toBe('v2');
  });
});

describe('a run redriven after its lease expired', () => {
  const FIRST_NODE = { id: 'first', type: 'transform', expression: 'start' };
  const EDGES = [{ from: 'first', to: 'answer' }];

  test('resumes its frontier on the graph it crashed on', async () => {
    const orchestrationId = await createOrchestration(
      [FIRST_NODE, markerNode('v1')],
      EDGES
    );
    // A driver that crashed after `first`: no entry point produces one, so the
    // row is written as the crash leaves it.
    const run = await db.OrchestrationRun.create({
      orchestrationId: await orchestrationPk(orchestrationId),
      orchestrationVersion: 1,
      projectId: projectPk,
      status: 'running',
      state: {},
      activeNodes: [],
      artifacts: { first: { result: 'start' } },
      input: {},
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    await rewire({
      orchestrationId,
      nodes: [FIRST_NODE, markerNode('v2')],
      edges: EDGES,
    });

    expect(await reapOrphanedRuns({ now: new Date() })).toBe(1);
    await drainOnceEnqueued(run.publicId as string);

    const settled = await getRun(run.publicId as string);
    expect(settled.status).toBe('succeeded');
    expect(settled.state.answer).toBe('v1');
  });
});

describe('a run resumed from `awaiting_input`', () => {
  test('human input finishes it on the graph it parked on', async () => {
    const humanNode = { id: 'human', type: 'human', prompt: 'Approve?' };
    const edges = [{ from: 'human', to: 'answer' }];
    const orchestrationId = await createOrchestration(
      [humanNode, markerNode('v1')],
      edges
    );
    const run = await startRun({ orchestrationId, wait: true });
    expect(run.status).toBe('awaiting_input');
    await rewire({
      orchestrationId,
      nodes: [humanNode, markerNode('v2')],
      edges,
    });

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/orchestration-runs/${run.id}/human-input`)
      .send({ node_id: 'human', output: { answer: 'yes' } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.state.answer).toBe('v1');
    expect(res.body.orchestration_version).toBe(1);
  });

  test('a paused run resumed through POST /resume finishes on the graph it paused on', async () => {
    const startNode = { id: 'first', type: 'transform', expression: 'start' };
    const edges = [{ from: 'first', to: 'answer' }];
    const orchestrationId = await createOrchestration(
      [startNode, markerNode('v1')],
      edges
    );
    const run = await startRun({ orchestrationId, wait: false });
    const paused = await authenticatedTestClient(userToken)
      .post(`/api/v1/orchestration-runs/${run.id}/pause`)
      .send({});
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('awaiting_input');
    await rewire({
      orchestrationId,
      nodes: [startNode, markerNode('v2')],
      edges,
    });

    const res = await authenticatedTestClient(userToken).post(
      `/api/v1/orchestration-runs/${run.id}/resume`
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.state.answer).toBe('v1');

    // The task the start enqueued is still there; draining it re-drives
    // nothing, since the run is already terminal.
    expect(await drainQueueOnce()).toBe(1);
    expect((await getRun(run.id)).state.answer).toBe('v1');
  });
});

describe('a queued run driven for the first time', () => {
  test('drives the graph it was enqueued on', async () => {
    const startNode = { id: 'first', type: 'transform', expression: 'start' };
    const edges = [{ from: 'first', to: 'answer' }];
    const orchestrationId = await createOrchestration(
      [startNode, markerNode('v1')],
      edges
    );
    const run = await startRun({ orchestrationId, wait: false });
    expect(run.status).toBe('queued');
    await rewire({
      orchestrationId,
      nodes: [startNode, markerNode('v2')],
      edges,
    });

    expect(await drainQueueOnce()).toBe(1);

    const settled = await getRun(run.id);
    expect(settled.status).toBe('succeeded');
    expect(settled.state.answer).toBe('v1');
  });
});
