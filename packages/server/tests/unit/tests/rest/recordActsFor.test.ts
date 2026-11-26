import { flushAuditQueue } from 'src/lib/auditQueue';
import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const PRINCIPAL = { type: 'mcp_key', id: 'deputy-1' };

/**
 * A record naming who acted serves whom that principal acted for beside it:
 * the IAM token's `principal`, while the principal pair names the minting key.
 */
describe('acts_for on records naming who acted', () => {
  let adminToken: string;
  let projectId: string;
  let keyId: string;
  let token: string;

  const createWorkflow = async (): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: `acts-for-${Math.random().toString(36).slice(2, 8)}`,
        states: [{ name: 'a', initial: true }, { name: 'b' }],
        transitions: [{ name: 'flip', from: ['a'], to: 'b' }],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createTask = async (workflowId: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const addStateAsToken = async (workflowId: string) => {
    const res = await authenticatedTestClient(token)
      .patch(`/api/v1/workflows/${workflowId}`)
      .send({
        states: [{ name: 'a', initial: true }, { name: 'b' }, { name: 'c' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'recordactsfor',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'deputy', project_id: projectId });
    expect(keyRes.status).toBe(201);
    keyId = keyRes.body.id;

    const tokenRes = await authenticatedTestClient(keyRes.body.key)
      .post('/api/v1/iam/tokens')
      .send({
        policy: { statement: [{ effect: 'Allow', action: ['*'] }] },
        principal: PRINCIPAL,
      });
    expect(tokenRes.status).toBe(201);
    token = tokenRes.body.token;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  test('a resource version names the token principal', async () => {
    const workflowId = await createWorkflow();
    await addStateAsToken(workflowId);

    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/workflows/${workflowId}/versions/2`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      created_by_principal_type: 'api_key',
      created_by_principal_id: keyId,
      created_by_acts_for: PRINCIPAL,
    });
  });

  test('a version written without a token acts for no one', async () => {
    const workflowId = await createWorkflow();

    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/workflows/${workflowId}/versions/1`
    );
    expect(res.status).toBe(200);
    expect(res.body.created_by_acts_for).toBeNull();
  });

  test('a workflow migration and the history it writes name the token principal', async () => {
    const workflowId = await createWorkflow();
    const taskId = await createTask(workflowId);
    await addStateAsToken(workflowId);

    const migration = await authenticatedTestClient(token)
      .post(`/api/v1/workflows/${workflowId}/migrations`)
      .send({ to_version: 2, wait: true });
    expect(migration.status).toBe(201);
    expect(migration.body).toMatchObject({
      status: 'completed',
      created_by_principal_id: keyId,
      created_by_acts_for: PRINCIPAL,
    });

    const history = await authenticatedTestClient(adminToken).get(
      `/api/v1/tasks/${taskId}/history`
    );
    expect(history.status).toBe(200);
    expect(history.body.data.at(-1)).toMatchObject({
      to_workflow_version: 2,
      principal_id: keyId,
      acts_for: PRINCIPAL,
    });
  });

  test('a task dependency names the token principal', async () => {
    const workflowId = await createWorkflow();
    const taskId = await createTask(workflowId);
    const dependsOnId = await createTask(workflowId);

    const res = await authenticatedTestClient(token)
      .post(`/api/v1/tasks/${taskId}/dependencies`)
      .send({ depends_on_task_id: dependsOnId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      created_by_principal_id: keyId,
      created_by_acts_for: PRINCIPAL,
    });
  });

  test('an audit entry names the token principal', async () => {
    const workflowId = await createWorkflow();
    await addStateAsToken(workflowId);
    await flushAuditQueue();

    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, principal_id: keyId });
    expect(res.status).toBe(200);
    const entry = (
      res.body.data as Array<{
        action: string;
        acts_for: { type: string; id: string } | null;
      }>
    ).find((candidate) => {
      return candidate.action === 'workflows:UpdateWorkflow';
    });
    expect(entry?.acts_for).toEqual(PRINCIPAL);
  });
});
