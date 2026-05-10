import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Memories', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let noPermToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'memoriesadmin', password: 'supersecret' });

    adminToken = await loginAs('memoriesadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'memoriesuser', password: 'memoriespass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('memoriesuser', 'memoriespass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Memories Test Project' });
    projectId = projectRes.body.id;

    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Memories Other Project' });
    otherProjectId = otherProjectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'memories:ListMemories',
                'memories:CreateMemory',
                'memories:GetMemory',
                'memories:UpdateMemory',
                'memories:DeleteMemory',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'memoriesnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('memoriesnoperm', 'nopassword');
  });

  describe('POST /api/v1/memories', () => {
    test('authenticated user with permission can create a memory', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Test Memory',
          description: 'A test memory',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^mem_/);
      expect(response.body.name).toBe('Test Memory');
      expect(response.body.description).toBe('A test memory');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
        });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/memories').send({
        project_id: projectId,
        name: 'Test Memory',
      });

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Test Memory',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memories', () => {
    test('authenticated user can list memories', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/memories');
      expect(response.status).toBe(401);
    });

    test('user without access to project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/memories')
        .query({ projectId: otherProjectId });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memories/:memory_id', () => {
    let memoryId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Get Test Memory',
        });
      memoryId = res.body.id;
    });

    test('authenticated user can get a memory', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${memoryId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(memoryId);
      expect(response.body.name).toBe('Get Test Memory');
    });

    test('returns 404 for non-existent memory', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memories/mem_nonexistent0000'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/memories/${memoryId}`);
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memories/${memoryId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/v1/memories/:memory_id', () => {
    let memoryId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Update Test Memory',
        });
      memoryId = res.body.id;
    });

    test('updates description only', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${memoryId}`)
        .send({ description: 'Updated description' });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Updated description');
    });

    test('authenticated user can update a memory name', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${memoryId}`)
        .send({
          name: 'Updated Memory Name',
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(memoryId);
      expect(response.body.name).toBe('Updated Memory Name');
    });

    test('returns 404 for non-existent memory', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/memories/mem_nonexistent0000')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/memories/${memoryId}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/memories/${memoryId}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/memories/:memory_id', () => {
    test('authenticated user can delete a memory', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Delete Test Memory',
        });
      const deleteMemId = createRes.body.id;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/memories/${deleteMemId}`
      );

      expect(response.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${deleteMemId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('returns 404 for non-existent memory', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/memories/mem_nonexistent0000'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Auth Delete Test',
        });
      const tempMemId = createRes.body.id;

      const response = await testClient.delete(`/api/v1/memories/${tempMemId}`);

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Perm Delete Test',
        });
      const tempMemId = createRes.body.id;

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/memories/${tempMemId}`
      );

      expect(response.status).toBe(403);
    });
  });
});
