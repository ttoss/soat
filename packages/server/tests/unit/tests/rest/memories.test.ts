import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Memories', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memories',
      policyActions: [
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
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;
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

    test('admin without project scoping gets an empty list', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/memories');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
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

    describe('POST /api/v1/memory-entries', () => {
      test('authenticated user can create a memory entry', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: freshMemoryId,
            content: 'Customer prefers email over phone',
          });

        expect(response.status).toBe(201);
        expect(response.body.id).toBeDefined();
        expect(response.body.id).toMatch(/^mem_entry_/);
        expect(response.body.content).toBe('Customer prefers email over phone');
        expect(response.body.source_type).toBe('manual');
        expect(response.body.memory_id).toBe(freshMemoryId);
        expect(response.body.created_at).toBeDefined();
        expect(response.body.action).toBe('created');
      });

      test('can create entry with explicit source_type', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: freshMemoryId,
            content: 'Agent created note',
            source_type: 'agent',
          });

        expect(response.status).toBe(201);
        expect(response.body.source_type).toBe('agent');
        expect(response.body.action).toBe('created');
      });

      test('returns 400 when content is missing', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: memoryId });

        expect(response.status).toBe(400);
      });

      test('returns 404 for non-existent memory', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: 'mem_nonexistent0000', content: 'test' });

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient
          .post('/api/v1/memory-entries')
          .send({ memory_id: memoryId, content: 'test' });

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: memoryId, content: 'test' });

        expect(response.status).toBe(403);
      });

      test('second write to same memory is skipped (duplicate)', async () => {
        const freshMemoryId = await createTestMemory();
        await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: freshMemoryId, content: 'First entry' });

        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: freshMemoryId,
            content: 'Second entry same memory',
          });

        expect(response.status).toBe(200);
        expect(response.body.action).toBe('skipped');
        expect(response.body.id).toMatch(/^mem_entry_/);
      });

      test('write with duplicate_threshold > 1 forces merge path', async () => {
        const freshMemoryId = await createTestMemory();
        await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: freshMemoryId, content: 'First entry for merge' });

        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: freshMemoryId,
            content: 'Second entry for merge',
            duplicate_threshold: 1.1,
            update_threshold: 0.0,
          });

        expect(response.status).toBe(200);
        expect(response.body.action).toBe('updated');
        expect(response.body.id).toMatch(/^mem_entry_/);
      });

      test('can create an entry with tags and metadata', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: freshMemoryId,
            content: 'Approve refunds under $50 automatically',
            tags: ['role:traffic-manager', 'source:rejected_approval'],
            metadata: { action_id: 'act_01', evidence: 'high' },
          });

        expect(response.status).toBe(201);
        expect(response.body.action).toBe('created');
        expect(response.body.tags).toEqual([
          'role:traffic-manager',
          'source:rejected_approval',
        ]);
        expect(response.body.metadata).toEqual({
          action_id: 'act_01',
          evidence: 'high',
        });
      });

      test('entry created without tags/metadata returns null for both', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: freshMemoryId, content: 'Untagged entry' });

        expect(response.status).toBe(201);
        expect(response.body.tags).toBeNull();
        expect(response.body.metadata).toBeNull();
      });

      test('honors source_type orchestration', async () => {
        const freshMemoryId = await createTestMemory();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: freshMemoryId,
            content: 'Written by an orchestration node',
            source_type: 'orchestration',
          });

        expect(response.status).toBe(201);
        expect(response.body.source_type).toBe('orchestration');
      });

      test('returns 400 when tags is not an array of strings', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: memoryId, content: 'x', tags: [1, 2, 3] });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/tags/);
      });

      test('returns 400 when metadata is not an object', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: memoryId, content: 'x', metadata: 'nope' });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/metadata/);
      });
    });

    describe('GET /api/v1/memory-entries', () => {
      test('authenticated user can list entries', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memory-entries?memory_id=${memoryId}`
        );

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/memory-entries?memory_id=${memoryId}`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/memory-entries?memory_id=${memoryId}`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('GET /api/v1/memory-entries/:entry_id', () => {
      let entryId: string;
      let getEntryMemoryId: string;

      beforeAll(async () => {
        getEntryMemoryId = await createTestMemory();
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: getEntryMemoryId, content: 'Entry to get' });
        entryId = res.body.id;
      });

      test('authenticated user can get an entry', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memory-entries/${entryId}`
        );

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(entryId);
        expect(response.body.content).toBe('Entry to get');
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memory-entries/me_nonexistent00000`
        );

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/memory-entries/${entryId}`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/memory-entries/${entryId}`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('PUT /api/v1/memory-entries/:entry_id', () => {
      let entryId: string;
      let putEntryMemoryId: string;

      beforeAll(async () => {
        putEntryMemoryId = await createTestMemory();
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: putEntryMemoryId, content: 'Entry to update' });
        entryId = res.body.id;
      });

      test('authenticated user can update an entry', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memory-entries/${entryId}`)
          .send({ content: 'Updated content' });

        expect(response.status).toBe(200);
        expect(response.body.content).toBe('Updated content');
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memory-entries/me_nonexistent00000`)
          .send({ content: 'x' });

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient
          .put(`/api/v1/memory-entries/${entryId}`)
          .send({ content: 'x' });

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken)
          .put(`/api/v1/memory-entries/${entryId}`)
          .send({ content: 'x' });

        expect(response.status).toBe(403);
      });

      test('can set and then clear tags/metadata', async () => {
        const memId = await createTestMemory();
        const created = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: memId, content: 'Taggable entry' });
        const id = created.body.id;

        const set = await authenticatedTestClient(userToken)
          .put(`/api/v1/memory-entries/${id}`)
          .send({ tags: ['role:pilot'], metadata: { k: 'v' } });
        expect(set.status).toBe(200);
        expect(set.body.tags).toEqual(['role:pilot']);
        expect(set.body.metadata).toEqual({ k: 'v' });

        const cleared = await authenticatedTestClient(userToken)
          .put(`/api/v1/memory-entries/${id}`)
          .send({ tags: null, metadata: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.tags).toBeNull();
        expect(cleared.body.metadata).toBeNull();
      });

      test('returns 400 when tags is invalid', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memory-entries/${entryId}`)
          .send({ tags: [1] });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/tags/);
      });
    });

    describe('DELETE /api/v1/memory-entries/:entry_id', () => {
      test('authenticated user can delete an entry', async () => {
        const deleteMemoryId = await createTestMemory();
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({ memory_id: deleteMemoryId, content: 'Entry to delete' });
        const entryId = createRes.body.id;

        const response = await authenticatedTestClient(userToken).delete(
          `/api/v1/memory-entries/${entryId}`
        );

        expect(response.status).toBe(204);

        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/memory-entries/${entryId}`
        );
        expect(getRes.status).toBe(404);
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken).delete(
          `/api/v1/memory-entries/me_nonexistent00000`
        );

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const deleteMemoryId = await createTestMemory();
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: deleteMemoryId,
            content: 'Auth Delete Test Entry',
          });
        const entryId = createRes.body.id;

        const response = await testClient.delete(
          `/api/v1/memory-entries/${entryId}`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const deleteMemoryId = await createTestMemory();
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-entries')
          .send({
            memory_id: deleteMemoryId,
            content: 'Perm Delete Test Entry',
          });
        const entryId = createRes.body.id;

        const response = await authenticatedTestClient(noPermToken).delete(
          `/api/v1/memory-entries/${entryId}`
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
      const ids = response.body.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryId);
      expect(ids).not.toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('glob tag pattern matches multiple memories', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId, tags: 'customer*' });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryId);
      expect(ids).toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('multiple tag patterns are ORed', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId, tags: ['crm', 'customer-prefs'] });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => {
        return m.id;
      });
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
      const ids = response.body.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).not.toContain(taggedMemoryId);
      expect(ids).not.toContain(prefixedMemoryId);
      expect(ids).not.toContain(untaggedMemoryId);
    });

    test('no tags filter returns all memories', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      const ids = response.body.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryId);
      expect(ids).toContain(prefixedMemoryId);
      expect(ids).toContain(untaggedMemoryId);
    });
  });
});
