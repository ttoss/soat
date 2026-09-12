import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Memories and memory entries evaluate `soat:ResourceTag/<key>` conditions the
 * way every other tagged resource does. Two tag bags meet on the entry routes:
 * the entry's own, and its memory's — an entry is never more visible than the
 * memory holding it, so a condition that hides a memory hides its entries too.
 */
describe('Tag conditions on memories and memory entries', () => {
  let adminToken: string;
  let restrictedToken: string;
  let projectId: string;
  let financeMemoryId: string;
  let engMemoryId: string;
  let engEntryId: string;
  let financeTaggedEntryId: string;

  const createMemory = async (args: {
    name: string;
    tags: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name: args.name, tags: args.tags });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createEntry = async (args: {
    memoryId: string;
    content: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-entries')
      .send({
        memory_id: args.memoryId,
        content: args.content,
        tags: args.tags,
        // The test embedding server answers every text with the same vector,
        // so without this every second entry in a memory is a "duplicate".
        duplicate_threshold: 1.1,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'memtagadmin', password: 'supersecret' });
    adminToken = await loginAs('memtagadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Memory Tag Conditions' });
    projectId = projectRes.body.id;

    financeMemoryId = await createMemory({
      name: 'payroll-notes',
      tags: { team: 'finance' },
    });
    engMemoryId = await createMemory({
      name: 'oncall-notes',
      tags: { team: 'eng' },
    });

    await createEntry({
      memoryId: financeMemoryId,
      content: 'Payroll runs on the 25th of each month.',
    });
    engEntryId = await createEntry({
      memoryId: engMemoryId,
      content: 'The on-call rotation changes every Monday.',
    });
    // Lives in the eng memory but carries the excluded tag itself, which is
    // what separates entry-level matching from container-level matching.
    financeTaggedEntryId = await createEntry({
      memoryId: engMemoryId,
      content: 'Contractor invoices are approved by finance.',
      tags: { team: 'finance' },
    });

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'memtagrestricted', password: 'memtagpass' });

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'memories:ListMemories',
                'memories:GetMemory',
                'memories:ListMemoryEntries',
                'memories:GetMemoryEntry',
                'knowledge:SearchKnowledge',
              ],
              resource: [`srn:${projectId}:*:*`],
              condition: {
                StringNotEquals: { 'soat:ResourceTag/team': 'finance' },
              },
            },
          ],
        },
      });
    expect(policyRes.status).toBe(201);

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    restrictedToken = await loginAs('memtagrestricted', 'memtagpass');
  });

  describe('GET /api/v1/memories', () => {
    test('omits a memory the condition excludes', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(engMemoryId);
      expect(ids).not.toContain(financeMemoryId);
    });

    test('admin sees both, so the omission above is the policy', async () => {
      const response = await authenticatedTestClient(adminToken)
        .get('/api/v1/memories')
        .query({ project_id: projectId });

      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toEqual(
        expect.arrayContaining([engMemoryId, financeMemoryId])
      );
    });
  });

  describe('GET /api/v1/memories/:memory_id', () => {
    test('returns the permitted memory', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memories/${engMemoryId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(engMemoryId);
    });

    test('403s on the excluded memory', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memories/${financeMemoryId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memory-entries', () => {
    test('omits an entry whose own tags the condition excludes', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .get('/api/v1/memory-entries')
        .query({ memory_id: engMemoryId });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((e: { id: string }) => {
        return e.id;
      });
      expect(ids).toContain(engEntryId);
      expect(ids).not.toContain(financeTaggedEntryId);
    });

    test('403s on an excluded memory, so its entries stay unreachable', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .get('/api/v1/memory-entries')
        .query({ memory_id: financeMemoryId });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memory-entries/:entry_id', () => {
    test('403s on an entry carrying the excluded tag', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memory-entries/${financeTaggedEntryId}`
      );

      expect(response.status).toBe(403);
    });

    test('returns a permitted entry', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memory-entries/${engEntryId}`
      );

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/knowledge/search', () => {
    const searchBody = () => {
      return { project_id: projectId, memory_ids: [] as string[] };
    };

    test('returns only entries the policy permits', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .post('/api/v1/knowledge/search')
        .send({
          ...searchBody(),
          memory_ids: [financeMemoryId, engMemoryId],
          limit: 50,
        });

      expect(response.status).toBe(200);
      const ids = response.body.results.map((r: { entry_id: string }) => {
        return r.entry_id;
      });
      expect(ids).toContain(engEntryId);
      expect(ids).not.toContain(financeTaggedEntryId);
    });

    test('admin, same query, sees every entry', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/knowledge/search')
        .send({
          ...searchBody(),
          memory_ids: [financeMemoryId, engMemoryId],
          limit: 50,
        });

      const ids = response.body.results.map((r: { entry_id: string }) => {
        return r.entry_id;
      });
      expect(ids).toEqual(
        expect.arrayContaining([engEntryId, financeTaggedEntryId])
      );
      expect(response.body.results.length).toBe(3);
    });
  });
});
