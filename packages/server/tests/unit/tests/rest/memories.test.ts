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
          config: { paths: ['/docs/'] },
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^mem_/);
      expect(response.body.name).toBe('Test Memory');
      expect(response.body.description).toBe('A test memory');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.config).toBeDefined();
      expect(response.body.config.paths).toEqual(['/docs/']);
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          config: { paths: ['/docs/'] },
        });

      expect(response.status).toBe(400);
    });

    test('create without config returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Missing Config',
        });

      expect(response.status).toBe(400);
    });

    test('create with empty config (no search/paths/documentIds) returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Empty Config',
          config: {},
        });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/memories').send({
        project_id: projectId,
        name: 'Test Memory',
        config: { paths: ['/docs/'] },
      });

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Test Memory',
          config: { paths: ['/docs/'] },
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
          config: { search: 'test query' },
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
      expect(response.body.config.search).toBe('test query');
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
          config: { paths: ['/original/'] },
        });
      memoryId = res.body.id;
    });

    test('authenticated user can update a memory', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${memoryId}`)
        .send({
          name: 'Updated Memory Name',
          config: { paths: ['/updated/'] },
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(memoryId);
      expect(response.body.name).toBe('Updated Memory Name');
      expect(response.body.config.paths).toEqual(['/updated/']);
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
          config: { document_ids: ['doc_test0000000000'] },
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
          config: { paths: ['/tmp/'] },
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
          config: { paths: ['/tmp/'] },
        });
      const tempMemId = createRes.body.id;

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/memories/${tempMemId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/memories/:memory_id/search', () => {
    let memoryId: string;
    let docId: string;

    beforeAll(async () => {
      // Create a document using admin token (memoriesuser lacks documents permission)
      const docRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'The quick brown fox jumps over the lazy dog',
          filename: 'fox-memory.txt',
        });
      docId = docRes.body.id;

      // Create a memory targeting that document
      const memRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Search Test Memory',
          config: { document_ids: [docId] },
        });
      memoryId = memRes.body.id;
    });

    test('search returns documents matching the memory config', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/memories/${memoryId}/search`)
        .send({});

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.documents)).toBe(true);
      expect(response.body.documents.length).toBeGreaterThan(0);
      expect(response.body.documents[0].id).toBe(docId);
    });

    test('search accepts override fields that replace config values', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/memories/${memoryId}/search`)
        .send({ limit: 1 });

      expect(response.status).toBe(200);
      expect(response.body.documents.length).toBeLessThanOrEqual(1);
    });

    test('returns 404 for non-existent memory', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories/mem_nonexistent0000/search')
        .send({});

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/memories/${memoryId}/search`)
        .send({});

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/memories/${memoryId}/search`)
        .send({});

      expect(response.status).toBe(403);
    });
  });
});
