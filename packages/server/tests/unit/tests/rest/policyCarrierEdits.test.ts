import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Editing a policy an API key or a user carries attaches the new document
 * again: the editor must hold every grant it adds where the carrier acts.
 */
describe('PUT /api/v1/policies/:policy_id on a carried policy', () => {
  let adminToken: string;
  let projectId: string;
  let managerToken: string;

  const document = (actions: string[]) => {
    return {
      statement: [
        {
          effect: 'Allow',
          action: actions,
          resource: [`srn:${projectId}:*:*`],
        },
      ],
    };
  };

  const KEY_ACTIONS = [
    'policies:GetPolicy',
    'policies:UpdatePolicy',
    'files:GetFile',
  ];

  const createProjectPolicy = async (actions: string[]) => {
    const res = await authenticatedTestClient(managerToken)
      .post('/api/v1/policies')
      .send({ project_id: projectId, document: document(actions) });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** A key of the manager narrowed by a fresh policy it may edit. */
  const narrowedKey = async () => {
    const policyId = await createProjectPolicy(KEY_ACTIONS);
    const res = await authenticatedTestClient(managerToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'carrier edit key',
        project_id: projectId,
        policy_ids: [policyId],
      });
    expect(res.status).toBe(201);
    return { policyId, key: res.body.key as string };
  };

  const editPolicy = (args: {
    token: string;
    policyId: string;
    actions: string[];
  }) => {
    return authenticatedTestClient(args.token)
      .put(`/api/v1/policies/${args.policyId}`)
      .send({ document: document(args.actions) });
  };

  /** A user carrying a fresh project policy. */
  const userCarriedPolicy = async (username: string) => {
    const policyId = await createProjectPolicy(['files:GetFile']);
    const user = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username, password: `${username}pass` });
    expect(user.status).toBe(201);
    const attach = await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policyId] });
    expect(attach.status).toBe(204);
    return policyId;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'carrieredit',
      policyActions: ['files:GetFile'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    managerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'carriereditmanager',
      actions: ['policies:*', 'files:GetFile', 'api-keys:*', 'webhooks:*'],
    });
  });

  test('a key narrowed by a policy cannot widen it past itself (403)', async () => {
    const { policyId, key } = await narrowedKey();

    const res = await editPolicy({
      token: key,
      policyId,
      actions: [...KEY_ACTIONS, 'webhooks:*'],
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
  });

  test('a key narrowed by a policy may narrow it further', async () => {
    const { policyId, key } = await narrowedKey();

    const res = await editPolicy({
      token: key,
      policyId,
      actions: ['policies:GetPolicy', 'policies:UpdatePolicy'],
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(policyId);
  });

  test("an editor holding the grant may widen a key's policy", async () => {
    const { policyId } = await narrowedKey();

    const res = await editPolicy({
      token: managerToken,
      policyId,
      actions: [...KEY_ACTIONS, 'webhooks:*'],
    });

    expect(res.status).toBe(200);
  });

  test("widening a user's policy past the editor is 403", async () => {
    const policyId = await userCarriedPolicy('carriereditwiden');

    const res = await editPolicy({
      token: managerToken,
      policyId,
      actions: ['files:GetFile', 'agents:*'],
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
  });

  test("an editor holding the grant may widen a user's policy", async () => {
    const policyId = await userCarriedPolicy('carriereditheld');

    const res = await editPolicy({
      token: managerToken,
      policyId,
      actions: ['files:GetFile', 'webhooks:*'],
    });

    expect(res.status).toBe(200);
  });

  test('without a token it is 401', async () => {
    const policyId = await userCarriedPolicy('carriereditanon');

    const res = await testClient
      .put(`/api/v1/policies/${policyId}`)
      .send({ document: document(['files:GetFile']) });

    expect(res.status).toBe(401);
  });
});
