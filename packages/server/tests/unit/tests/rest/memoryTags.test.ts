import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('MemoryTags', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;

  const createMemory = async (args: {
    name: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name: args.name, tags: args.tags });
    return res.body.id as string;
  };

  // The test embedding stub returns one constant vector, so every entry looks
  // like a duplicate of the last; a threshold above 1 keeps each write distinct.
  const createEntry = async (args: {
    memoryId: string;
    content: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-entries')
      .send({
        memory_id: args.memoryId,
        content: args.content,
        tags: args.tags,
        duplicate_threshold: 1.1,
      });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memtags',
      policyActions: [
        'memories:ListMemories',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:UpdateMemory',
        'memories:ListMemoryEntries',
        'memories:CreateMemoryEntry',
        'memories:GetMemoryEntry',
        'memories:UpdateMemoryEntry',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  });

  describe('GET/PUT/PATCH /api/v1/memories/:memory_id/tags', () => {
    let memoryId: string;

    beforeAll(async () => {
      memoryId = await createMemory({
        name: 'Tag Sub-resource Memory',
        tags: { team: 'support' },
      });
    });

    test('GET returns the tag map', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${memoryId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ team: 'support' });
    });

    test('PUT replaces the tag map', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${memoryId}/tags`)
        .send({ env: 'prod' });

      expect(response.status).toBe(200);
      // The response is the tag map itself, not the memory resource.
      expect(response.body).toEqual({ env: 'prod' });
    });

    test('PATCH merges into the tag map', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/memories/${memoryId}/tags`)
        .send({ team: 'sales' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ env: 'prod', team: 'sales' });

      const memory = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${memoryId}`
      );
      expect(memory.body.tags).toEqual({ env: 'prod', team: 'sales' });
    });

    test('PUT rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${memoryId}/tags`)
        .send({ team: ['a'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/memories/${memoryId}/tags`
      );

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/memories/${memoryId}/tags`)
        .send({ env: 'prod' });

      expect(response.status).toBe(403);
    });

    test('non-existent memory returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memories/mem_nonexistent/tags'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET/PUT/PATCH /api/v1/memory-entries/:entry_id/tags', () => {
    let entryId: string;

    beforeAll(async () => {
      const memoryId = await createMemory({
        name: 'Entry Tag Sub-resource Memory',
      });
      entryId = await createEntry({
        memoryId,
        content: 'Entry with tags',
        tags: { role: 'manager' },
      });
    });

    test('GET returns the tag map', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-entries/${entryId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ role: 'manager' });
    });

    test('PUT replaces and PATCH merges the tag map', async () => {
      const put = await authenticatedTestClient(userToken)
        .put(`/api/v1/memory-entries/${entryId}/tags`)
        .send({ source: 'manual' });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ source: 'manual' });

      const patch = await authenticatedTestClient(userToken)
        .patch(`/api/v1/memory-entries/${entryId}/tags`)
        .send({ role: 'agent' });
      expect(patch.status).toBe(200);
      expect(patch.body).toEqual({ source: 'manual', role: 'agent' });
    });

    test('PATCH rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/memory-entries/${entryId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/memory-entries/${entryId}/tags`
      );

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memory-entries/${entryId}/tags`
      );

      expect(response.status).toBe(403);
    });

    test('non-existent entry returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memory-entries/mem_entry_nonexistent/tags'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/memory-entries with tag filter', () => {
    let memoryId: string;
    let managerEntryId: string;
    let agentEntryId: string;

    beforeAll(async () => {
      memoryId = await createMemory({ name: 'Entry Tag Filter Memory' });
      managerEntryId = await createEntry({
        memoryId,
        content: 'Manager rule',
        tags: { role: 'manager' },
      });
      agentEntryId = await createEntry({
        memoryId,
        content: 'Agent rule',
        tags: { role: 'agent' },
      });
    });

    test('a key:value pair returns only entries carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-entries')
        .query({ memory_id: memoryId, tags: 'role:manager' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((e: { id: string }) => {
        return e.id;
      });
      expect(ids).toEqual([managerEntryId]);
      expect(ids).not.toContain(agentEntryId);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-entries')
        .query({ memory_id: memoryId, tags: 'manager' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
