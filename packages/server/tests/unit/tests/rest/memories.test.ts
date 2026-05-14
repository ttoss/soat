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
                'memories:ListMemoryEntries',
                'memories:CreateMemoryEntry',
                'memories:GetMemoryEntry',
                'memories:UpdateMemoryEntry',
                'memories:DeleteMemoryEntry',
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

    test('can create a memory with tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Tagged Memory',
          tags: ['projectA', 'customer-support'],
        });

      expect(response.status).toBe(201);
      expect(response.body.tags).toEqual(['projectA', 'customer-support']);
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

  describe('Memory Entries', () => {
    let memoryId: string;

    const createTestMemory = async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({ project_id: projectId, name: `Test Memory ${Date.now()}` });
      return res.body.id as string;
    };

    beforeAll(async () => {
      memoryId = await createTestMemory();
    });

    describe('POST /api/v1/memories/:memory_id/entries', () => {
      test('authenticated user can create a memory entry', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${freshMemoryId}/entries`)
          .send({ content: 'Customer prefers email over phone' });

        expect(response.status).toBe(201);
        expect(response.body.id).toBeDefined();
        expect(response.body.id).toMatch(/^me_/);
        expect(response.body.content).toBe('Customer prefers email over phone');
        expect(response.body.source).toBe('manual');
        expect(response.body.memory_id).toBe(freshMemoryId);
        expect(response.body.created_at).toBeDefined();
        expect(response.body.action).toBe('created');
      });

      test('can create entry with explicit source', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${freshMemoryId}/entries`)
          .send({ content: 'Agent created note', source: 'agent' });

        expect(response.status).toBe(201);
        expect(response.body.source).toBe('agent');
        expect(response.body.action).toBe('created');
      });

      test('returns 400 when content is missing', async () => {
        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${memoryId}/entries`)
          .send({});

        expect(response.status).toBe(400);
      });

      test('returns 404 for non-existent memory', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories/mem_nonexistent0000/entries')
          .send({ content: 'test' });

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient
          .post(`/api/v1/memories/${memoryId}/entries`)
          .send({ content: 'test' });

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken)
          .post(`/api/v1/memories/${memoryId}/entries`)
          .send({ content: 'test' });

        expect(response.status).toBe(403);
      });

      test('second write to same memory is skipped (duplicate)', async () => {
        const freshMemoryId = await createTestMemory();
        await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${freshMemoryId}/entries`)
          .send({ content: 'First entry' });

        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${freshMemoryId}/entries`)
          .send({ content: 'Second entry same memory' });

        expect(response.status).toBe(200);
        expect(response.body.action).toBe('skipped');
        expect(response.body.id).toMatch(/^me_/);
      });

      test('write with duplicate_threshold > 1 forces merge path', async () => {
        const freshMemoryId = await createTestMemory();
        await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${freshMemoryId}/entries`)
          .send({ content: 'First entry for merge' });

        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${freshMemoryId}/entries`)
          .send({
            content: 'Second entry for merge',
            duplicate_threshold: 1.1,
            update_threshold: 0.0,
          });

        expect(response.status).toBe(200);
        expect(response.body.action).toBe('updated');
        expect(response.body.id).toMatch(/^me_/);
      });
    });

    describe('GET /api/v1/memories/:memory_id/entries', () => {
      test('authenticated user can list entries', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${memoryId}/entries`
        );

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/memories/${memoryId}/entries`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/memories/${memoryId}/entries`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('GET /api/v1/memories/:memory_id/entries/:entry_id', () => {
      let entryId: string;
      let getEntryMemoryId: string;

      beforeAll(async () => {
        getEntryMemoryId = await createTestMemory();
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${getEntryMemoryId}/entries`)
          .send({ content: 'Entry to get' });
        entryId = res.body.id;
      });

      test('authenticated user can get an entry', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${getEntryMemoryId}/entries/${entryId}`
        );

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(entryId);
        expect(response.body.content).toBe('Entry to get');
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${getEntryMemoryId}/entries/me_nonexistent00000`
        );

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/memories/${getEntryMemoryId}/entries/${entryId}`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/memories/${getEntryMemoryId}/entries/${entryId}`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('PUT /api/v1/memories/:memory_id/entries/:entry_id', () => {
      let entryId: string;
      let putEntryMemoryId: string;

      beforeAll(async () => {
        putEntryMemoryId = await createTestMemory();
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${putEntryMemoryId}/entries`)
          .send({ content: 'Entry to update' });
        entryId = res.body.id;
      });

      test('authenticated user can update an entry', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memories/${putEntryMemoryId}/entries/${entryId}`)
          .send({ content: 'Updated content' });

        expect(response.status).toBe(200);
        expect(response.body.content).toBe('Updated content');
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(
            `/api/v1/memories/${putEntryMemoryId}/entries/me_nonexistent00000`
          )
          .send({ content: 'x' });

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient
          .put(`/api/v1/memories/${putEntryMemoryId}/entries/${entryId}`)
          .send({ content: 'x' });

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken)
          .put(`/api/v1/memories/${putEntryMemoryId}/entries/${entryId}`)
          .send({ content: 'x' });

        expect(response.status).toBe(403);
      });
    });

    describe('DELETE /api/v1/memories/:memory_id/entries/:entry_id', () => {
      test('authenticated user can delete an entry', async () => {
        const deleteMemoryId = await createTestMemory();
        const createRes = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${deleteMemoryId}/entries`)
          .send({ content: 'Entry to delete' });
        const entryId = createRes.body.id;

        const response = await authenticatedTestClient(userToken).delete(
          `/api/v1/memories/${deleteMemoryId}/entries/${entryId}`
        );

        expect(response.status).toBe(204);

        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${deleteMemoryId}/entries/${entryId}`
        );
        expect(getRes.status).toBe(404);
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken).delete(
          `/api/v1/memories/${memoryId}/entries/me_nonexistent00000`
        );

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const deleteMemoryId = await createTestMemory();
        const createRes = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${deleteMemoryId}/entries`)
          .send({ content: 'Auth Delete Test Entry' });
        const entryId = createRes.body.id;

        const response = await testClient.delete(
          `/api/v1/memories/${deleteMemoryId}/entries/${entryId}`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const deleteMemoryId = await createTestMemory();
        const createRes = await authenticatedTestClient(userToken)
          .post(`/api/v1/memories/${deleteMemoryId}/entries`)
          .send({ content: 'Perm Delete Test Entry' });
        const entryId = createRes.body.id;

        const response = await authenticatedTestClient(noPermToken).delete(
          `/api/v1/memories/${deleteMemoryId}/entries/${entryId}`
        );

        expect(response.status).toBe(403);
      });
    });
  });

  describe('GET /api/v1/memories with tag filter', () => {
    let taggedMemoryId: string;
    let prefixedMemoryId: string;
    let untaggedMemoryId: string;

    beforeAll(async () => {
      const taggedRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Tagged Memory Alpha',
          tags: ['customer-support', 'crm'],
        });
      taggedMemoryId = taggedRes.body.id;

      const prefixedRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Tagged Memory Beta',
          tags: ['customer-prefs'],
        });
      prefixedMemoryId = prefixedRes.body.id;

      const untaggedRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: 'Untagged Memory',
        });
      untaggedMemoryId = untaggedRes.body.id;
    });

    test('exact tag match returns only matching memories', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId, tags: 'crm' });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => m.id);
      expect(ids).toContain(taggedMemoryId);
      expect(ids).not.toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('glob tag pattern matches multiple memories', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId, tags: 'customer*' });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => m.id);
      expect(ids).toContain(taggedMemoryId);
      expect(ids).toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('multiple tag patterns are ORed', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId, tags: ['crm', 'customer-prefs'] });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => m.id);
      expect(ids).toContain(taggedMemoryId);
      expect(ids).toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('tag pattern with no match returns empty array', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId, tags: 'nonexistent-tag-xyz*' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const ids = response.body.map((m: { id: string }) => m.id);
      expect(ids).not.toContain(taggedMemoryId);
      expect(ids).not.toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('no tags filter returns all memories', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => m.id);
      expect(ids).toContain(taggedMemoryId);
      expect(ids).toContain(prefixedMemoryId);
      expect(ids).toContain(untaggedMemoryId);
    });
  });
});
