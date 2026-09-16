import { isolateMemory } from '../../fixtures/memoryWrites';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Memory stores and memories evaluate `soat:ResourceTag/<key>` conditions the
 * way every other tagged resource does. Two tag bags meet on the entry routes:
 * the entry's own, and its memory store's — an entry is never more visible than the
 * memory store holding it, so a condition that hides a memory store hides its entries too.
 */
describe('Tag conditions on memoryStores and memories', () => {
  let adminToken: string;
  let restrictedToken: string;
  let projectId: string;
  let financeMemoryStoreId: string;
  let engMemoryStoreId: string;
  let engEntryId: string;
  let financeTaggedEntryId: string;

  const createMemoryStore = async (args: {
    name: string;
    tags: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: args.name, tags: args.tags });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createEntry = async (args: {
    memoryStoreId: string;
    content: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({
        memory_store_id: args.memoryStoreId,
        content: args.content,
        tags: args.tags,
      });
    expect(res.status).toBe(201);
    // The test embedding server answers every text with the same vector, so
    // without this every second entry in a memory store is a "duplicate".
    await isolateMemory({ memoryId: res.body.id as string });
    return res.body.id as string;
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'memtagadmin', password: 'supersecret' });
    adminToken = await loginAs('memtagadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'MemoryStore Tag Conditions' });
    projectId = projectRes.body.id;

    financeMemoryStoreId = await createMemoryStore({
      name: 'payroll-notes',
      tags: { team: 'finance' },
    });
    engMemoryStoreId = await createMemoryStore({
      name: 'oncall-notes',
      tags: { team: 'eng' },
    });

    await createEntry({
      memoryStoreId: financeMemoryStoreId,
      content: 'Payroll runs on the 25th of each month.',
    });
    engEntryId = await createEntry({
      memoryStoreId: engMemoryStoreId,
      content: 'The on-call rotation changes every Monday.',
    });
    // Lives in the eng memory store but carries the excluded tag itself, which is
    // what separates entry-level matching from container-level matching.
    financeTaggedEntryId = await createEntry({
      memoryStoreId: engMemoryStoreId,
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
                'memories:ListMemoryStores',
                'memories:GetMemoryStore',
                'memories:ListMemories',
                'memories:GetMemory',
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

  describe('GET /api/v1/memory-stores', () => {
    test('omits a memoryStore the condition excludes', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(engMemoryStoreId);
      expect(ids).not.toContain(financeMemoryStoreId);
    });

    test('admin sees both, so the omission above is the policy', async () => {
      const response = await authenticatedTestClient(adminToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId });

      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toEqual(
        expect.arrayContaining([engMemoryStoreId, financeMemoryStoreId])
      );
    });
  });

  describe('GET /api/v1/memory-stores/:memory_store_id', () => {
    test('returns the permitted memoryStore', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memory-stores/${engMemoryStoreId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(engMemoryStoreId);
    });

    test('403s on the excluded memoryStore', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memory-stores/${financeMemoryStoreId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memories', () => {
    test('omits an entry whose own tags the condition excludes', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .get('/api/v1/memories')
        .query({ memory_store_id: engMemoryStoreId });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((e: { id: string }) => {
        return e.id;
      });
      expect(ids).toContain(engEntryId);
      expect(ids).not.toContain(financeTaggedEntryId);
    });

    test('403s on an excluded memoryStore, so its entries stay unreachable', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .get('/api/v1/memories')
        .query({ memory_store_id: financeMemoryStoreId });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memories/:memory_id', () => {
    test('403s on an entry carrying the excluded tag', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memories/${financeTaggedEntryId}`
      );

      expect(response.status).toBe(403);
    });

    test('returns a permitted entry', async () => {
      const response = await authenticatedTestClient(restrictedToken).get(
        `/api/v1/memories/${engEntryId}`
      );

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/knowledge/search', () => {
    const searchBody = () => {
      return { project_id: projectId, memory_store_ids: [] as string[] };
    };

    test('returns only entries the policy permits', async () => {
      const response = await authenticatedTestClient(restrictedToken)
        .post('/api/v1/knowledge/search')
        .send({
          ...searchBody(),
          memory_store_ids: [financeMemoryStoreId, engMemoryStoreId],
          limit: 50,
        });

      expect(response.status).toBe(200);
      const ids = response.body.results.map((r: { memory_id: string }) => {
        return r.memory_id;
      });
      expect(ids).toContain(engEntryId);
      expect(ids).not.toContain(financeTaggedEntryId);
    });

    test('admin, same query, sees every entry', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/knowledge/search')
        .send({
          ...searchBody(),
          memory_store_ids: [financeMemoryStoreId, engMemoryStoreId],
          limit: 50,
        });

      const ids = response.body.results.map((r: { memory_id: string }) => {
        return r.memory_id;
      });
      expect(ids).toEqual(
        expect.arrayContaining([engEntryId, financeTaggedEntryId])
      );
      expect(response.body.results.length).toBe(3);
    });
  });
});
