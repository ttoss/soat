import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

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
      .send({ username: 'akeyalice', password: 'alicepass' });

    aliceId = aliceRes.body.id;
    aliceToken = await loginAs('akeyalice', 'alicepass');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'akeybob', password: 'bobpass' });

    bobToken = await loginAs('akeybob', 'bobpass');

    const projRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'API Key Test Project' });

    projectId = projRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ permissions: ['files:GetFile'] });

    policyId = policyRes.body.id;
  });

  describe('POST /api/v1/api-keys', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/api-keys')
        .send({ name: 'Test' });

      expect(response.status).toBe(401);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({});

      expect(response.status).toBe(400);
    });

    test('invalid project_id returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Test', project_id: 'proj_nonexistent12345' });

      expect(response.status).toBe(400);
    });

    test('invalid policy_ids returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Test', policy_ids: ['pol_nonexistent12345'] });

      expect(response.status).toBe(400);
    });

    test('user can create an API key with project and policy', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Alice Key',
          project_id: projectId,
          policy_ids: [policyId],
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
      expect(response.body.name).toBe('Alice Key');
      expect(response.body.key).toMatch(/^sk_/);
      expect(response.body.key_prefix).toBeDefined();
      expect(response.body.key_prefix).toBe(response.body.key.slice(0, 8));
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
      // raw key is only returned at creation — no user_id/project_id/policy_ids in create response
      expect(response.body.user_id).toBeUndefined();
    });

    test('user can create a minimal API key without project or policies', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Minimal Key' });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
      expect(response.body.key).toMatch(/^sk_/);
    });

    test('admin can also create an API key', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Admin Key', project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.key).toMatch(/^sk_/);
    });
  });

  describe('GET /api/v1/api-keys/:id', () => {
    let keyId: string;
    let rawKey: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Get Test Key',
          project_id: projectId,
          policy_ids: [policyId],
        });

      keyId = res.body.id;
      rawKey = res.body.key;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });

    test('non-existent key returns 404', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        '/api/v1/api-keys/key_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });

    test('other user returns 403', async () => {
      const response = await authenticatedTestClient(bobToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(403);
    });

    test('owner can get key details', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
      expect(response.body.name).toBe('Get Test Key');
      expect(response.body.key_prefix).toBeDefined();
      expect(response.body.user_id).toBe(aliceId);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.policy_ids).toContain(policyId);
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('raw key is never returned in GET response', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.body.key).toBeUndefined();
    });

    test('admin can get any key', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
    });

    test('api key bearer auth works with raw key', async () => {
      const response = await authenticatedTestClient(rawKey).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
    });
  });

  describe('PUT /api/v1/api-keys/:id', () => {
    let keyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Put Test Key' });

      keyId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(401);
    });

    test('non-existent key returns 404', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put('/api/v1/api-keys/key_nonexistent12345')
        .send({ name: 'Updated' });

      expect(response.status).toBe(404);
    });

    test('other user returns 403', async () => {
      const response = await authenticatedTestClient(bobToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(403);
    });

    test('owner can update key name', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ name: 'Updated Key Name' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
      expect(response.body.name).toBe('Updated Key Name');
      expect(response.body.key).toBeUndefined();
    });

    test('owner can attach policies via update', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ policy_ids: [policyId] });

      expect(response.status).toBe(200);
      expect(response.body.policy_ids).toContain(policyId);
    });

    test('owner can scope key to a project via update', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(response.body.project_id).toBe(projectId);
    });

    test('owner can clear project scope by setting project_id to null', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ project_id: null });

      expect(response.status).toBe(200);
      expect(response.body.project_id).toBeNull();
    });
  });

  describe('DELETE /api/v1/api-keys/:id', () => {
    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Delete Unauth' });

      const response = await testClient.delete(
        `/api/v1/api-keys/${createRes.body.id}`
      );

      expect(response.status).toBe(401);
    });

    test('other user returns 403', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Delete Other' });

      const response = await authenticatedTestClient(bobToken).delete(
        `/api/v1/api-keys/${createRes.body.id}`
      );

      expect(response.status).toBe(403);
    });

    test('non-existent key returns 404', async () => {
      const response = await authenticatedTestClient(aliceToken).delete(
        '/api/v1/api-keys/key_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });

    test('owner can delete their key', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Delete Me' });

      const keyId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(aliceToken).delete(
        `/api/v1/api-keys/${keyId}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(getRes.status).toBe(404);
    });

    test('admin can delete any key', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Admin Delete Me' });

      const keyId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/api-keys/${keyId}`
      );

      expect(deleteRes.status).toBe(204);
    });
  });

  describe('API key project scoping', () => {
    let projectAId: string;
    let rawKey: string;

    beforeAll(async () => {
      const projARes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Scope Project A' });

      projectAId = projARes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Scope Project B' });

      // Give alice a policy that allows listing projects
      const listPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ permissions: ['projects:ListProjects'] });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${aliceId}/policies`)
        .send({ policy_ids: [listPolicyRes.body.id] });

      const keyRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Scoped Key', project_id: projectAId });

      rawKey = keyRes.body.key;
    });

    test('api key scoped to project only sees that project when listing', async () => {
      const response =
        await authenticatedTestClient(rawKey).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);
      expect(response.body[0].id).toBe(projectAId);
    });

    afterAll(async () => {
      // Detach alice's project-listing policy so it doesn't bleed into other tests
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${aliceId}/policies`)
        .send({ policy_ids: [] });
    });
  });
});
