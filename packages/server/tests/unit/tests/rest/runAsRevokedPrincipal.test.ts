import { db } from 'src/db';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * A background run re-mints its credential from the principal that started
 * it each time a worker drives it. When that principal is gone by then — the
 * API key revoked, the user deleted — the run must not act at all: falling
 * back to a token for the key's owning user would widen the run's reach to
 * everything that user may do. Its `soat` self-calls go out unauthenticated
 * and fail.
 *
 * Each run lists the project's tools through a `soat` tool node, which an
 * owner-scoped credential would answer successfully.
 */

const RUN_ACTIONS = [
  'orchestrations:GetOrchestration',
  'orchestrations:StartRun',
  'orchestrations:GetRun',
  'tools:GetTool',
  'tools:CallTool',
  'tools:ListTools',
];

let adminToken: string;
let projectId: string;
let orchestrationId: string;
let policyId: string;

/** Starts a durable run with `token`; the worker has not driven it yet. */
const startQueued = async (token: string) => {
  const res = await authenticatedTestClient(token)
    .post('/api/v1/orchestration-runs')
    .send({ orchestration_id: orchestrationId, input: {} });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('queued');
  return res.body.id as string;
};

/** Drives the run as the worker would and returns it as an admin reads it. */
const driveAndRead = async (runId: string) => {
  expect(await drainQueueOnce()).toBe(1);
  const res = await authenticatedTestClient(adminToken).get(
    `/api/v1/orchestration-runs/${runId}`
  );
  expect(res.status).toBe(200);
  return res.body as {
    status: string;
    error: { code: string; message: string } | null;
  };
};

beforeAll(async () => {
  // The worker kick is disabled so the principal can be revoked between the
  // start and the drive.
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

  const setup = await setupProjectWithUsers({
    prefix: 'runasgone',
    policyActions: ['orchestrations:CreateOrchestration', ...RUN_ACTIONS],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
  policyId = setup.policyId;

  const toolRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/tools')
    .send({
      project_id: projectId,
      name: 'runasgone-list-tools',
      type: 'builtin',
      actions: ['list-tools'],
    });
  expect(toolRes.status).toBe(201);

  const orchestrationRes = await authenticatedTestClient(setup.userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: 'runasgone-list',
      nodes: [
        {
          id: 'call',
          type: 'tool',
          tool_id: toolRes.body.id,
          operation_id: 'list-tools',
          input_mapping: { project_id: projectId },
        },
      ],
      edges: [],
    });
  expect(orchestrationRes.status).toBe(201);
  orchestrationId = orchestrationRes.body.id;
});

afterAll(() => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
});

describe('a background run whose starting principal is gone', () => {
  test('an API key revoked before the drive leaves the run unauthenticated', async () => {
    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        name: 'runasgone-revoked',
        policy_ids: [policyId],
      });
    expect(keyRes.status).toBe(201);
    const runId = await startQueued(keyRes.body.key as string);
    const run = await db.OrchestrationRun.findOne({
      where: { publicId: runId },
    });
    expect(run!.principalKind).toBe('api_key');

    const revoked = await authenticatedTestClient(adminToken).delete(
      `/api/v1/api-keys/${keyRes.body.id}`
    );
    expect(revoked.status).toBe(204);

    const settled = await driveAndRead(runId);
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('TOOL_HTTP_ERROR');
  });

  test('a user deleted before the drive leaves the run unauthenticated', async () => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'runasgone-leaver', password: 'leaverpass' });
    expect(userRes.status).toBe(201);
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyId] });
    const runId = await startQueued(
      await loginAs('runasgone-leaver', 'leaverpass')
    );

    const deleted = await authenticatedTestClient(adminToken).delete(
      `/api/v1/users/${userRes.body.id}`
    );
    expect(deleted.status).toBe(204);

    const settled = await driveAndRead(runId);
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('TOOL_HTTP_ERROR');
  });
});
