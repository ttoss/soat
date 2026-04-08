import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('API Keys', () => {
  let adminToken: string;
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;
  let projectId: string;
  let policyId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const aliceRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'alice', password: 'alicepass' });
    aliceId = aliceRes.body.id;
    aliceToken = await loginAs('alice', 'alicepass');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'bob', password: 'bobpass' });
    bobToken = await loginAs('bob', 'bobpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({ permissions: ['files:read'] });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: aliceId, policyId });
  });

  describe('POST /api/v1/api-keys', () => {
    test('returns 401 if not authenticated', async () => {
      const response = await testClient
        .post('/api/v1/api-keys')
        .send({ projectId, policyId, name: 'My Key' });

      expect(response.status).toBe(401);
    });

    test('returns 400 if required fields are missing', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'My Key' });

      expect(response.status).toBe(400);
    });

    test('returns 400 if project does not exist', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ projectId: 'proj_nonexistent', policyId, name: 'My Key' });

      expect(response.status).toBe(400);
    });

    test('returns 403 if user is not a member of the project', async () => {
      const response = await authenticatedTestClient(bobToken)
        .post('/api/v1/api-keys')
        .send({ projectId, policyId, name: 'Bob Key' });

      expect(response.status).toBe(403);
    });

    test('returns 400 if policy does not belong to the project', async () => {
      const otherProjectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Other Project' });
      const otherProjectId = otherProjectRes.body.id;

      const otherPolicyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${otherProjectId}/policies`)
        .send({ permissions: ['files:read'] });
      const otherPolicyId = otherPolicyRes.body.id;

      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ projectId, policyId: otherPolicyId, name: 'My Key' });

      expect(response.status).toBe(400);
    });

    test('returns 201 and the full key on success', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ projectId, policyId, name: 'Alice Key' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Alice Key');
      expect(response.body.key).toBeDefined();
      expect(response.body.keyPrefix).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
    });
  });

  describe('GET /api/v1/api-keys/:id', () => {
    let apiKeyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ projectId, policyId, name: 'Get Test Key' });
      apiKeyId = res.body.id;
    });

    test('returns 401 if not authenticated', async () => {
      const response = await testClient.get(`/api/v1/api-keys/${apiKeyId}`);

      expect(response.status).toBe(401);
    });

    test('returns 404 if api key does not exist', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        '/api/v1/api-keys/key_nonexistent'
      );

      expect(response.status).toBe(404);
    });

    test('returns 403 if user does not own the api key', async () => {
      const response = await authenticatedTestClient(bobToken).get(
        `/api/v1/api-keys/${apiKeyId}`
      );

      expect(response.status).toBe(403);
    });

    test('returns 200 and api key data without the full key', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${apiKeyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(apiKeyId);
      expect(response.body.name).toBe('Get Test Key');
      expect(response.body.keyPrefix).toBeDefined();
      expect(response.body.key).toBeUndefined();
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
    });
  });

  describe('PUT /api/v1/api-keys/:id', () => {
    let apiKeyId: string;
    let newPolicyId: string;

    beforeAll(async () => {
      const keyRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ projectId, policyId, name: 'Update Test Key' });
      apiKeyId = keyRes.body.id;

      const newPolicyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['files:write'] });
      newPolicyId = newPolicyRes.body.id;
    });

    test('returns 401 if not authenticated', async () => {
      const response = await testClient
        .put(`/api/v1/api-keys/${apiKeyId}`)
        .send({ policyId: newPolicyId });

      expect(response.status).toBe(401);
    });

    test('returns 400 if policyId is missing', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${apiKeyId}`)
        .send({});

      expect(response.status).toBe(400);
    });

    test('returns 400 if policy does not exist', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${apiKeyId}`)
        .send({ policyId: 'policy_nonexistent' });

      expect(response.status).toBe(400);
    });

    test('returns 404 if api key does not exist', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put('/api/v1/api-keys/key_nonexistent')
        .send({ policyId: newPolicyId });

      expect(response.status).toBe(404);
    });

    test('returns 403 if user does not own the api key', async () => {
      const response = await authenticatedTestClient(bobToken)
        .put(`/api/v1/api-keys/${apiKeyId}`)
        .send({ policyId: newPolicyId });

      expect(response.status).toBe(403);
    });

    test('returns 400 if policy belongs to a different project', async () => {
      const otherProjectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Other Update Project' });
      const otherProjectId = otherProjectRes.body.id;

      const otherPolicyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${otherProjectId}/policies`)
        .send({ permissions: ['files:read'] });
      const otherPolicyId = otherPolicyRes.body.id;

      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${apiKeyId}`)
        .send({ policyId: otherPolicyId });

      expect(response.status).toBe(400);
    });

    test('returns 200 and the updated api key', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${apiKeyId}`)
        .send({ policyId: newPolicyId });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(apiKeyId);
      expect(response.body.policyId).toBe(newPolicyId);
    });
  });
});
