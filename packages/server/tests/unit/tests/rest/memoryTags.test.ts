import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { isolateMemory } from '../../fixtures/memoryWrites';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('MemoryStoreTags', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;

  const createMemoryStore = async (args: {
    name: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: args.name, tags: args.tags });
    return res.body.id as string;
  };

  // The test embedding stub returns one constant vector, so every entry looks
  // like a duplicate of the last; isolating each one keeps the writes distinct.
  const createEntry = async (args: {
    memoryStoreId: string;
    content: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({
        memory_store_id: args.memoryStoreId,
        content: args.content,
        tags: args.tags,
      });
    // Every stub embedding is identical, so without this each write after the
    // first would match the last one and be skipped as a duplicate.
    await isolateMemory({ memoryId: res.body.id as string });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memtags',
      policyActions: [
        'memories:ListMemoryStores',
        'memories:CreateMemoryStore',
        'memories:GetMemoryStore',
        'memories:UpdateMemoryStore',
        'memories:ListMemories',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:UpdateMemory',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  });

  describe('GET/PUT/PATCH /api/v1/memory-stores/:memory_store_id/tags', () => {
    let memoryStoreId: string;

    beforeAll(async () => {
      memoryStoreId = await createMemoryStore({
        name: 'Tag Sub-resource MemoryStore',
        tags: { team: 'support' },
      });
    });

    test('GET returns the tag map', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ team: 'support' });
    });

    test('PUT replaces the tag map', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memory-stores/${memoryStoreId}/tags`)
        .send({ env: 'prod' });

      expect(response.status).toBe(200);
      // The response is the tag map itself, not the memory store resource.
      expect(response.body).toEqual({ env: 'prod' });
    });

    test('PATCH merges into the tag map', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/memory-stores/${memoryStoreId}/tags`)
        .send({ team: 'sales' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ env: 'prod', team: 'sales' });

      const memoryStore = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}`
      );
      expect(memoryStore.body.tags).toEqual({ env: 'prod', team: 'sales' });
    });

    test('PUT /memory-stores/:id with tags: null clears the bag', async () => {
      const cleared = await createMemoryStore({
        name: 'Cleared Tags MemoryStore',
        tags: { team: 'support' },
      });

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memory-stores/${cleared}`)
        .send({ tags: null });

      expect(response.status).toBe(200);
      expect(response.body.tags).toBeUndefined();

      const tags = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${cleared}/tags`
      );
      expect(tags.body).toEqual({});
    });

    test('PUT rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memory-stores/${memoryStoreId}/tags`)
        .send({ team: ['a'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/memory-stores/${memoryStoreId}/tags`
      );

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/memory-stores/${memoryStoreId}/tags`)
        .send({ env: 'prod' });

      expect(response.status).toBe(403);
    });

    test('non-existent memoryStore returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memory-stores/mstore_nonexistent/tags'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET/PUT/PATCH /api/v1/memories/:memory_id/tags', () => {
    let entryId: string;

    beforeAll(async () => {
      const memoryStoreId = await createMemoryStore({
        name: 'Entry Tag Sub-resource MemoryStore',
      });
      entryId = await createEntry({
        memoryStoreId,
        content: 'Entry with tags',
        tags: { role: 'manager' },
      });
    });

    test('GET returns the tag map', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${entryId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ role: 'manager' });
    });

    test('GET returns {} for an entry written without tags', async () => {
      const memoryStoreId = await createMemoryStore({
        name: 'Untagged Entry MemoryStore',
      });
      const untaggedId = await createEntry({
        memoryStoreId,
        content: 'Entry without tags',
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${untaggedId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    test('PUT replaces and PATCH merges the tag map', async () => {
      const put = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${entryId}/tags`)
        .send({ source: 'manual' });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ source: 'manual' });

      const patch = await authenticatedTestClient(userToken)
        .patch(`/api/v1/memories/${entryId}/tags`)
        .send({ role: 'agent' });
      expect(patch.status).toBe(200);
      expect(patch.body).toEqual({ source: 'manual', role: 'agent' });
    });

    test('PATCH rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/memories/${entryId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/memories/${entryId}/tags`);

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memories/${entryId}/tags`
      );

      expect(response.status).toBe(403);
    });

    test('non-existent entry returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memories/mem_nonexistent/tags'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/memories with tag filter', () => {
    let memoryStoreId: string;
    let managerEntryId: string;
    let agentEntryId: string;

    beforeAll(async () => {
      memoryStoreId = await createMemoryStore({
        name: 'Entry Tag Filter MemoryStore',
      });
      managerEntryId = await createEntry({
        memoryStoreId,
        content: 'Manager rule',
        tags: { role: 'manager' },
      });
      agentEntryId = await createEntry({
        memoryStoreId,
        content: 'Agent rule',
        tags: { role: 'agent' },
      });
    });

    test('a key:value pair returns only entries carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ memory_store_id: memoryStoreId, tags: 'role:manager' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((e: { id: string }) => {
        return e.id;
      });
      expect(ids).toEqual([managerEntryId]);
      expect(ids).not.toContain(agentEntryId);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ memory_store_id: memoryStoreId, tags: 'manager' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
