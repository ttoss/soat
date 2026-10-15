import { db } from 'src/db';
import {
  drainPlaybookExecutions,
  flushPlaybookExecutions,
  recoverPlaybookExecutions,
} from 'src/lib/playbookCascade';
import { recoverPlaybookExports } from 'src/lib/playbookExportRender';

import { pollUntil } from '../../fixtures/agentToolTurn';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The cascade's sweeps, driven as the server process drives them: the drain
 * runs queued executions, the recovery sweep settles a `running` one past its
 * lease. Cases are written through the API with the in-process worker off, so
 * every execution runs at a sweep the test makes. The one state no entry point
 * produces — an execution a stopped process left running — is written
 * directly.
 */

const COLLECT = {
  nodes: [
    {
      key: 'revenue',
      title: 'Revenue',
      kind: 'collect',
      inputs: [
        {
          name: 'amount',
          schema: { type: 'number' },
          required: true,
          source: 'manual',
        },
      ],
    },
  ],
};

let adminToken: string;
let projectId: string;
let humanOrchestrationId: string;
let seq = 0;

const asAdmin = () => {
  return authenticatedTestClient(adminToken);
};

const newCase = async (definition: object): Promise<string> => {
  seq += 1;
  const playbook = await asAdmin()
    .post('/api/v1/playbooks')
    .send({ project_id: projectId, name: `jobs-${seq}`, definition });
  const created = await asAdmin()
    .post(`/api/v1/playbooks/${playbook.body.id}/cases`)
    .send({ subject: `jobs-${seq}` });
  return created.body.id as string;
};

const writeAmount = async (caseId: string) => {
  const res = await asAdmin()
    .post(`/api/v1/playbook-cases/${caseId}/inputs`)
    .send({
      inputs: [
        { node: 'revenue', name: 'amount', value: 3, expected_revision: null },
      ],
    });
  expect(res.status).toBe(200);
};

const executionsOf = async (caseId: string) => {
  const res = await asAdmin().get(
    `/api/v1/playbook-cases/${caseId}/executions`
  );
  return res.body.data as Array<Record<string, unknown> & { id: string }>;
};

/** Runs `fn` with the in-process worker on, as the server has it. */
const withWorker = async (fn: () => Promise<unknown>) => {
  delete process.env.PLAYBOOK_WORKER_DISABLED;
  try {
    await fn();
    await flushPlaybookExecutions();
  } finally {
    process.env.PLAYBOOK_WORKER_DISABLED = 'true';
  }
};

beforeAll(async () => {
  process.env.PLAYBOOK_WORKER_DISABLED = 'true';
  const setup = await setupProjectWithUsers({
    prefix: 'playbookjobs',
    policyActions: [],
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
  const orchestration = await asAdmin()
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: 'jobs-human',
      nodes: [{ id: 'ask', type: 'human', prompt: 'Approve?' }],
      edges: [],
    });
  humanOrchestrationId = orchestration.body.id;
});

afterAll(() => {
  delete process.env.PLAYBOOK_WORKER_DISABLED;
});

describe('drainPlaybookExecutions', () => {
  test('runs what the cascade queued', async () => {
    const caseId = await newCase(COLLECT);
    await writeAmount(caseId);
    expect((await executionsOf(caseId))[0].status).toBe('pending');

    await withWorker(drainPlaybookExecutions);

    expect((await executionsOf(caseId))[0]).toMatchObject({
      status: 'succeeded',
      output: { amount: 3 },
    });
  });

  test('settles superseded, without running it, an execution whose inputs moved while queued', async () => {
    const caseId = await newCase(COLLECT);
    await writeAmount(caseId);
    const current = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    const moved = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node: 'revenue',
            name: 'amount',
            value: 4,
            expected_revision: current.body.nodes[0].inputs[0].revision,
          },
        ],
      });
    expect(moved.status).toBe(200);

    await withWorker(drainPlaybookExecutions);

    const [rerun, queued] = await executionsOf(caseId);
    expect(queued).toMatchObject({
      result: 'superseded',
      output: null,
      output_revision: null,
    });
    expect(rerun).toMatchObject({
      status: 'succeeded',
      result: 'current',
      output: { amount: 4 },
    });
  });

  test('leaves a paused case queued until it is resumed', async () => {
    const caseId = await newCase(COLLECT);
    await writeAmount(caseId);
    await asAdmin().post(`/api/v1/playbook-cases/${caseId}/pause`);

    await withWorker(drainPlaybookExecutions);
    expect((await executionsOf(caseId))[0].status).toBe('pending');

    await withWorker(() => {
      return asAdmin().post(`/api/v1/playbook-cases/${caseId}/resume`);
    });
    expect((await executionsOf(caseId))[0].status).toBe('succeeded');
  });
});

describe('recoverPlaybookExecutions', () => {
  test('fails, as interrupted, an execution a stopped process left running', async () => {
    const caseId = await newCase(COLLECT);
    await writeAmount(caseId);
    const [queued] = await executionsOf(caseId);
    // A worker claimed it and stopped before settling.
    await db.PlaybookExecution.update(
      { status: 'running', leaseExpiresAt: new Date(Date.now() - 1000) },
      { where: { publicId: queued.id } }
    );

    expect(await recoverPlaybookExecutions({ now: new Date() })).toBe(1);

    const [recovered] = await pollUntil({
      read: () => {
        return executionsOf(caseId);
      },
      done: (rows) => {
        return rows[0].status !== 'running';
      },
    });
    expect(recovered).toMatchObject({
      status: 'failed',
      error: { code: 'PLAYBOOK_EXECUTION_INTERRUPTED' },
    });
  });

  test('settles an execution whose run ended without an event', async () => {
    const caseId = await newCase({
      nodes: [
        {
          ...COLLECT.nodes[0],
          kind: 'execute',
          executor: { type: 'orchestration', id: humanOrchestrationId },
        },
      ],
    });
    await withWorker(() => {
      return writeAmount(caseId);
    });
    const [parked] = await executionsOf(caseId);
    expect(parked.status).toBe('running');
    const cancelled = await asAdmin().post(
      `/api/v1/orchestration-runs/${parked.run_id}/cancel`
    );
    expect(cancelled.status).toBe(200);

    const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(await recoverPlaybookExecutions({ now: later })).toBe(1);

    const [recovered] = await pollUntil({
      read: () => {
        return executionsOf(caseId);
      },
      done: (rows) => {
        return rows[0].status !== 'running';
      },
    });
    expect(recovered).toMatchObject({
      status: 'failed',
      error: { code: 'PLAYBOOK_EXECUTION_FAILED' },
    });
  });
});

describe('recoverPlaybookExports', () => {
  test('fails, as interrupted, an export a stopped process left running', async () => {
    const caseId = await newCase(COLLECT);
    await withWorker(() => {
      return writeAmount(caseId);
    });
    const row = await db.PlaybookCase.findOne({ where: { publicId: caseId } });
    // A process recorded it, called the tool and stopped before settling.
    const left = await db.PlaybookExport.create({
      caseId: row!.id as number,
      node: 'revenue',
      revision: 2,
      playbookVersion: 1,
      transformation: 'proposal',
      format: 'pdf',
      toolId: 'tool_gone',
      status: 'running',
      leaseExpiresAt: new Date(Date.now() - 1000),
      createdByUserId: null,
    });

    expect(await recoverPlaybookExports({ now: new Date() })).toBe(1);

    const res = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/exports/${left.publicId}`
    );
    expect(res.body).toMatchObject({
      status: 'failed',
      error: { code: 'PLAYBOOK_EXPORT_INTERRUPTED' },
      finished_at: expect.any(String),
    });
  });

  test('leaves an export inside its lease running', async () => {
    const caseId = await newCase(COLLECT);
    const row = await db.PlaybookCase.findOne({ where: { publicId: caseId } });
    await db.PlaybookExport.create({
      caseId: row!.id as number,
      node: 'revenue',
      revision: 1,
      playbookVersion: 1,
      transformation: 'proposal',
      format: 'pdf',
      toolId: 'tool_live',
      status: 'running',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      createdByUserId: null,
    });

    expect(await recoverPlaybookExports({ now: new Date() })).toBe(0);
  });
});
