import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A principal an IAM token acts for is revoked in its project: work it
 * started resolves no caller from then on, while work for another principal
 * on the same key runs.
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
let otherProjectId: string;
let orchestrationId: string;
let policyId: string;
let projectKey: string;
let readOnlyKey: string;

const createKey = async (args: { name: string; policyIds: string[] }) => {
  const res = await authenticatedTestClient(adminToken)
    .post('/api/v1/api-keys')
    .send({
      project_id: projectId,
      name: args.name,
      policy_ids: args.policyIds,
    });
  expect(res.status).toBe(201);
  return res.body.key as string;
};

const revoke = (credential: string, body: Record<string, unknown>) => {
  return authenticatedTestClient(credential)
    .post('/api/v1/iam/principal-revocations')
    .send(body);
};

/** Starts a queued run on an IAM token acting for `principalId`. */
const startFor = async (principalId: string) => {
  const minted = await authenticatedTestClient(projectKey)
    .post('/api/v1/iam/tokens')
    .send({
      policy_ids: [policyId],
      principal: { type: 'api_key', id: principalId },
    });
  expect(minted.status).toBe(201);
  const res = await authenticatedTestClient(minted.body.token as string)
    .post('/api/v1/orchestration-runs')
    .send({ orchestration_id: orchestrationId, input: {} });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('queued');
  return res.body.id as string;
};

const driveAndRead = async (runId: string) => {
  expect(await drainQueueOnce()).toBe(1);
  const res = await authenticatedTestClient(adminToken).get(
    `/api/v1/orchestration-runs/${runId}`
  );
  expect(res.status).toBe(200);
  return res.body as { status: string; error: { code: string } | null };
};

beforeAll(async () => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

  const setup = await setupProjectWithUsers({
    prefix: 'prnrevoke',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'iam:CreateToken',
      'iam:RevokePrincipal',
      ...RUN_ACTIONS,
    ],
    createOtherProject: true,
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  projectId = setup.projectId;
  otherProjectId = setup.otherProjectId!;
  policyId = setup.policyId;

  const readOnly = await authenticatedTestClient(adminToken)
    .post('/api/v1/policies')
    .send({
      document: {
        statement: [{ effect: 'Allow', action: ['orchestrations:GetRun'] }],
      },
    });
  expect(readOnly.status).toBe(201);

  projectKey = await createKey({
    name: 'prnrevoke-project',
    policyIds: [policyId],
  });
  readOnlyKey = await createKey({
    name: 'prnrevoke-read-only',
    policyIds: [readOnly.body.id],
  });

  const toolRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/tools')
    .send({
      project_id: projectId,
      name: 'prnrevoke-list-tools',
      type: 'builtin',
      actions: ['list-tools'],
    });
  expect(toolRes.status).toBe(201);

  const orchestrationRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: 'prnrevoke-list',
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

describe('POST /api/v1/iam/principal-revocations', () => {
  test('revokes a principal in the key project, idempotently', async () => {
    const body = { principal: { type: 'api_key', id: 'nk_idempotent' } };
    expect((await revoke(projectKey, body)).status).toBe(204);
    expect((await revoke(projectKey, body)).status).toBe(204);
  });

  test('401 without a credential', async () => {
    const res = await testClient
      .post('/api/v1/iam/principal-revocations')
      .send({ principal: { type: 'api_key', id: 'nk_anon' } });
    expect(res.status).toBe(401);
  });

  test('403 for a key not allowed iam:RevokePrincipal', async () => {
    const res = await revoke(readOnlyKey, {
      principal: { type: 'api_key', id: 'nk_denied' },
    });
    expect(res.status).toBe(403);
  });

  test('403 for a project the key is not scoped to', async () => {
    const res = await revoke(projectKey, {
      project_id: otherProjectId,
      principal: { type: 'api_key', id: 'nk_other' },
    });
    expect(res.status).toBe(403);
  });

  test.each([
    [{}],
    [{ principal: { type: 'api_key' } }],
    [{ principal: { type: '', id: 'nk_1' } }],
    [{ principal: { type: 'api_key', id: 'x'.repeat(256) } }],
  ])('400 for an invalid principal %j', async (body) => {
    const res = await revoke(projectKey, body);
    expect(res.status).toBe(400);
  });
});

describe('work acting for a revoked principal', () => {
  test('resolves no caller once its principal is revoked', async () => {
    const runId = await startFor('nk_revoked');
    expect(
      (
        await revoke(projectKey, {
          principal: { type: 'api_key', id: 'nk_revoked' },
        })
      ).status
    ).toBe(204);

    const settled = await driveAndRead(runId);
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('WORK_AUTHORITY_MISSING');
  });

  test('runs while its principal is not revoked', async () => {
    const runId = await startFor('nk_live');
    const settled = await driveAndRead(runId);
    expect(settled.status).toBe('completed');
  });
});
