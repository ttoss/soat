import { db } from 'src/db';
import { driveQueuedRun } from 'src/lib/orchestrationEngine';
import { resumeOrchestrationRun } from 'src/lib/orchestrationRunActions';
import { reapOrphanedRuns, wakeDueRuns } from 'src/lib/orchestrationScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A run executes the graph it started on, not the graph the orchestration holds
 * now (issue #872).
 *
 * Each test drives one of the four execution entry points against the real
 * database, with the orchestration edited **after** the run was created:
 *
 * | Entry point | Reached through |
 * |---|---|
 * | `wakeRun` | `wakeDueRuns` — the scheduler, for a run parked on a timer |
 * | `redriveRun` | `reapOrphanedRuns` — the reaper, for a run whose lease expired |
 * | `resumeOrchestrationRunExecution` | `POST /orchestration-runs/:id/resume` |
 * | `driveQueuedRun` | the worker's own entry point, called directly |
 *
 * Every graph's second node writes a marker into state, so the assertion names
 * *which topology ran* rather than merely that the run finished. Before pinning
 * these all resolved the live `Orchestration` row and every one of them read
 * `v2` — including the wake path, where the edit can land days after the run
 * started.
 */

let userToken: string;
let projectPublicId: string;
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
    .send({
      project_id: projectPublicId,
      name: `Pinning ${orchSeq}`,
      nodes,
      edges,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
};

/** Rewires the marker node to report `v2`, bumping the orchestration's version. */
const rewireToV2 = async (args: {
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

const orchPk = async (publicId: string): Promise<number> => {
  const orch = await db.Orchestration.findOne({ where: { publicId } });
  return orch?.id as number;
};

/**
 * Polls a run row until it reaches one of `statuses`. Uses no timer APIs, so each
 * real DB round-trip yields to the event loop and lets the scheduler's detached
 * wake/redrive work progress (the shape `orchestrationScheduler.test.ts` uses).
 */
const waitForRunStatus = async (
  orchestrationRunId: number,
  statuses: string[]
): Promise<InstanceType<typeof db.OrchestrationRun>> => {
  for (let i = 0; i < 3000; i += 1) {
    const run = await db.OrchestrationRun.findByPk(orchestrationRunId);
    if (run && statuses.includes(run.status)) return run;
  }
  throw new Error(
    `run ${orchestrationRunId} never reached ${statuses.join('/')}`
  );
};

const runState = (
  run: InstanceType<typeof db.OrchestrationRun>
): Record<string, unknown> => {
  return run.state as Record<string, unknown>;
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'orchpin',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:UpdateOrchestration',
      'orchestrations:GetRun',
      'orchestrations:ResumeRun',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectPublicId = setup.projectId;
  const project = await db.Project.findOne({
    where: { publicId: projectPublicId },
  });
  projectPk = project?.id as number;
});

describe('a run woken from `sleeping`', () => {
  // The issue's own reproduction: a run parked on a `delay` whose graph is
  // rewired while it sleeps.
  const DELAY_NODE = {
    id: 'delay',
    type: 'delay',
    duration: '1s',
    state_mapping: { 'state.waited': { var: 'output.waited' } },
  };
  const EDGES = [{ from: 'delay', to: 'answer' }];

  const parkSleepingRun = async (args: {
    orchestrationPk: number;
    orchestrationVersion: number | null;
  }) => {
    return db.OrchestrationRun.create({
      orchestrationId: args.orchestrationPk,
      orchestrationVersion: args.orchestrationVersion,
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
  };

  test('executes the graph it went to sleep on, not the edited one', async () => {
    const orch = await createOrchestration(
      [DELAY_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);
    const run = await parkSleepingRun({
      orchestrationPk: pk,
      orchestrationVersion: orch.version,
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [DELAY_NODE, markerNode('v2')],
      edges: EDGES,
    });

    await wakeDueRuns();
    const settled = await waitForRunStatus(run.id as number, [
      'succeeded',
      'failed',
    ]);

    expect(settled.status).toBe('succeeded');
    expect(runState(settled).answer).toBe('v1');
  });

  test('still runs a node the edit deleted', async () => {
    // The sharper form of the same bug: with the successor gone from the live
    // graph, an unpinned run resolves no next node and settles having silently
    // skipped the work it was created to do.
    const orch = await createOrchestration(
      [DELAY_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);
    const run = await parkSleepingRun({
      orchestrationPk: pk,
      orchestrationVersion: orch.version,
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [DELAY_NODE],
      edges: [],
    });

    await wakeDueRuns();
    const settled = await waitForRunStatus(run.id as number, [
      'succeeded',
      'failed',
    ]);

    expect(settled.status).toBe('succeeded');
    expect(runState(settled).answer).toBe('v1');
  });

  test('a run with no pinned version executes the live graph', async () => {
    // Runs created before pinning existed carry a null version. The live row is
    // the only graph they ever had, so they keep the pre-#872 behaviour rather
    // than being stranded.
    const orch = await createOrchestration(
      [DELAY_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);
    const run = await parkSleepingRun({
      orchestrationPk: pk,
      orchestrationVersion: null,
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [DELAY_NODE, markerNode('v2')],
      edges: EDGES,
    });

    await wakeDueRuns();
    const settled = await waitForRunStatus(run.id as number, [
      'succeeded',
      'failed',
    ]);

    expect(settled.status).toBe('succeeded');
    expect(runState(settled).answer).toBe('v2');
  });

  test('a pinned version whose archive is gone falls back to the live graph', async () => {
    // Only reachable by deleting the archive row out of band — the API deletes
    // versions with their orchestration, which takes the runs with it. The run
    // degrades to the live graph rather than losing the work it has done.
    const orch = await createOrchestration(
      [DELAY_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);
    const run = await parkSleepingRun({
      orchestrationPk: pk,
      orchestrationVersion: orch.version,
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [DELAY_NODE, markerNode('v2')],
      edges: EDGES,
    });
    await db.OrchestrationVersion.destroy({
      where: { orchestrationId: pk, version: orch.version },
    });

    await wakeDueRuns();
    const settled = await waitForRunStatus(run.id as number, [
      'succeeded',
      'failed',
    ]);

    expect(settled.status).toBe('succeeded');
    expect(runState(settled).answer).toBe('v2');
  });
});

describe('a run redriven after its lease expired', () => {
  const FIRST_NODE = { id: 'first', type: 'transform', expression: 'start' };
  const EDGES = [{ from: 'first', to: 'answer' }];

  test('resumes the frontier on the graph it crashed on', async () => {
    const orch = await createOrchestration(
      [FIRST_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);

    // `first` already produced an artifact, so the redrive frontier is `answer`.
    const run = await db.OrchestrationRun.create({
      orchestrationId: pk,
      orchestrationVersion: orch.version,
      projectId: projectPk,
      status: 'running',
      state: {},
      activeNodes: [],
      artifacts: { first: { result: 'start' } },
      input: {},
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [FIRST_NODE, markerNode('v2')],
      edges: EDGES,
    });

    await reapOrphanedRuns();
    const settled = await waitForRunStatus(run.id as number, [
      'succeeded',
      'failed',
    ]);

    expect(settled.status).toBe('succeeded');
    expect(runState(settled).answer).toBe('v1');
  });
});

describe('a run resumed from `awaiting_input`', () => {
  const HUMAN_NODE = { id: 'human', type: 'human', prompt: 'Approve?' };
  const EDGES = [{ from: 'human', to: 'answer' }];

  test('finishes on the graph it parked on', async () => {
    const orch = await createOrchestration(
      [HUMAN_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);

    const run = await db.OrchestrationRun.create({
      orchestrationId: pk,
      orchestrationVersion: orch.version,
      projectId: projectPk,
      status: 'awaiting_input',
      state: {},
      // The human node is done; the run resumes from its successor.
      activeNodes: ['answer'],
      artifacts: { human: { answer: 'yes' } },
      input: {},
      startedAt: new Date(),
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [HUMAN_NODE, markerNode('v2')],
      edges: EDGES,
    });

    const resumed = await resumeOrchestrationRun({
      runPublicId: run.publicId as string,
      projectIds: [projectPk],
    });

    expect(resumed.status).toBe('succeeded');
    expect(resumed.state.answer).toBe('v1');
    expect(resumed.orchestration_version).toBe(orch.version);
  });
});

describe('a queued run driven for the first time', () => {
  const START_NODE = { id: 'first', type: 'transform', expression: 'start' };
  const EDGES = [{ from: 'first', to: 'answer' }];

  test('drives the graph it was enqueued on', async () => {
    const orch = await createOrchestration(
      [START_NODE, markerNode('v1')],
      EDGES
    );
    const pk = await orchPk(orch.id);

    const run = await db.OrchestrationRun.create({
      orchestrationId: pk,
      orchestrationVersion: orch.version,
      projectId: projectPk,
      status: 'queued',
      state: {},
      activeNodes: [],
      artifacts: {},
      input: {},
      startedAt: new Date(),
    });

    await rewireToV2({
      orchestrationId: orch.id,
      nodes: [START_NODE, markerNode('v2')],
      edges: EDGES,
    });

    // The worker's own entry point. Called directly rather than through a queue
    // drain because the drain claims whatever else is enqueued in this database,
    // which would make the assertion depend on unrelated tests' runs.
    await driveQueuedRun({ run });

    const settled = await waitForRunStatus(run.id as number, [
      'succeeded',
      'failed',
    ]);
    expect(settled.status).toBe('succeeded');
    expect(runState(settled).answer).toBe('v1');
  });
});
