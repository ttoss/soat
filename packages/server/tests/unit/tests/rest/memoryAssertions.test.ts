import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { setMemorySimilarity } from '../../fixtures/memoryWrites';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('MemoryAssertions', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'massert',
      policyActions: [
        'memories:CreateMemoryStore',
        'memories:GetMemoryStore',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:ListMemoryAssertions',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
  });

  const createMemoryStore = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: `${name} ${Date.now()}` });
    return res.body.id as string;
  };

  const writeMemory = async (args: {
    memoryStoreId: string;
    content: string;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({ memory_store_id: args.memoryStoreId, content: args.content });
    return res.body as { id: string; action: string };
  };

  describe('GET /api/v1/memories/:memory_id/assertions', () => {
    test('returns the writes that resolved into the memory', async () => {
      const memoryStoreId = await createMemoryStore('History');
      const created = await writeMemory({
        memoryStoreId,
        content: 'Customer prefers email',
      });
      // A restatement of a fact already known lands on the same memory as a
      // skip — the outcome that left no record at all before this table.
      await writeMemory({
        memoryStoreId,
        content: 'The customer would rather be emailed',
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${created.id}/assertions`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(2);
      expect(
        response.body.data.map((assertion: { outcome: string }) => {
          return assertion.outcome;
        })
      ).toEqual(['created', 'skipped']);
      expect(response.body.data[0].id).toMatch(/^massert_/);
      expect(response.body.data[0].memory_id).toBe(created.id);
      expect(response.body.data[0].mechanism).toBe('api');
      expect(response.body.data[0].principal_type).toBe('user');
      // Nothing existed to compare the first write against.
      expect(response.body.data[0].similarity).toBeNull();
      expect(response.body.data[1].similarity).toBeGreaterThan(0.9);
      // The text as asserted, not the memory's text.
      expect(response.body.data[1].content).toBe(
        'The customer would rather be emailed'
      );
    });

    test('names the memory a supersede retired, through the reverse join', async () => {
      const memoryStoreId = await createMemoryStore('Supersede History');
      const retired = await writeMemory({
        memoryStoreId,
        content: 'Delivery window is two weeks',
      });
      await setMemorySimilarity({ memoryId: retired.id, similarity: 0.92 });

      const replacement = await writeMemory({
        memoryStoreId,
        content: 'Delivery window is four weeks',
      });
      expect(replacement.action).toBe('superseded');

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${replacement.id}/assertions`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].outcome).toBe('superseded');
      expect(response.body.data[0].memory_id).toBe(replacement.id);
      expect(response.body.data[0].superseded_memory_id).toBe(retired.id);
    });

    test('a retired memory keeps its own assertions', async () => {
      const memoryStoreId = await createMemoryStore('Retired History');
      const retired = await writeMemory({
        memoryStoreId,
        content: 'Contact is Priya',
      });
      await setMemorySimilarity({ memoryId: retired.id, similarity: 0.92 });
      await writeMemory({ memoryStoreId, content: 'Contact is Sam' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${retired.id}/assertions`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].outcome).toBe('created');
    });

    test('unauthenticated request returns 401', async () => {
      const memoryStoreId = await createMemoryStore('Unauth History');
      const created = await writeMemory({
        memoryStoreId,
        content: 'Unauthenticated read',
      });

      const response = await testClient.get(
        `/api/v1/memories/${created.id}/assertions`
      );

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const memoryStoreId = await createMemoryStore('Forbidden History');
      const created = await writeMemory({
        memoryStoreId,
        content: 'Forbidden read',
      });

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memories/${created.id}/assertions`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 for a non-existent memory', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memories/mem_nonexistent/assertions'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/memory-stores/:memory_store_id/assertions', () => {
    test("returns the store's ledger newest first", async () => {
      const memoryStoreId = await createMemoryStore('Store Ledger');
      await writeMemory({ memoryStoreId, content: 'Ledger first fact' });
      await writeMemory({ memoryStoreId, content: 'Ledger second fact' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(2);
      expect(
        response.body.data.map((assertion: { outcome: string }) => {
          return assertion.outcome;
        })
      ).toEqual(['skipped', 'created']);
      expect(response.body.data[0].memory_store_id).toBe(memoryStoreId);
    });

    test('filters by outcome', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Outcome');
      await writeMemory({ memoryStoreId, content: 'Outcome first fact' });
      await writeMemory({ memoryStoreId, content: 'Outcome second fact' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?outcome=skipped`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);
      expect(response.body.data[0].outcome).toBe('skipped');
    });

    test('filters by mechanism', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Mechanism');
      await writeMemory({ memoryStoreId, content: 'Mechanism fact' });

      const viaApi = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?mechanism=api`
      );
      const viaTool = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?mechanism=tool`
      );

      expect(viaApi.body.total).toBe(1);
      expect(viaTool.body.total).toBe(0);
    });

    // A generation that does not exist must select nothing, rather than
    // silently widening to the whole store.
    test('an unknown generation_id matches nothing', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Generation');
      await writeMemory({ memoryStoreId, content: 'Generation fact' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?generation_id=gen_nope`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    test('filters by since', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Since');
      await writeMemory({ memoryStoreId, content: 'Since fact' });

      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();

      const afterFuture = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?since=${future}`
      );
      const afterPast = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?since=${past}`
      );

      expect(afterFuture.body.total).toBe(0);
      expect(afterPast.body.total).toBe(1);
    });

    test('an unknown mechanism returns 400', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Bad Mechanism');

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?mechanism=telepathy`
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a since that is not a timestamp returns 400', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Bad Since');

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions?since=yesterday`
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Unauth');

      const response = await testClient.get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions`
      );

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const memoryStoreId = await createMemoryStore('Ledger Forbidden');

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/assertions`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 for a non-existent memory store', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memory-stores/mstore_nonexistent/assertions'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('memory store dedup policy', () => {
    test('reports null thresholds until a store sets them', async () => {
      const memoryStoreId = await createMemoryStore('Unset Policy');

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.duplicate_threshold).toBeNull();
      expect(response.body.supersede_threshold).toBeNull();
    });

    test('stores and reports a threshold pair', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: `Set Policy ${Date.now()}`,
          duplicate_threshold: 0.9,
          supersede_threshold: 0.8,
        });

      expect(response.status).toBe(201);
      expect(response.body.duplicate_threshold).toBe(0.9);
      expect(response.body.supersede_threshold).toBe(0.8);
    });

    test('rejects a pair that is not supersede < duplicate', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: `Bad Policy ${Date.now()}`,
          duplicate_threshold: 0.8,
          supersede_threshold: 0.8,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a threshold outside [0, 1]', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: `Range Policy ${Date.now()}`,
          duplicate_threshold: 1.4,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    // The update checks against the stored values it does not replace, so a
    // one-field change cannot invert the pair from the side.
    test('rejects a one-field update that inverts the stored pair', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: `Update Policy ${Date.now()}`,
          duplicate_threshold: 0.9,
          supersede_threshold: 0.8,
        });

      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/memory-stores/${created.body.id}`)
        .send({ supersede_threshold: 0.95 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('clears a threshold back to the algorithm default with null', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: `Clear Policy ${Date.now()}`,
          duplicate_threshold: 0.9,
          supersede_threshold: 0.8,
        });

      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/memory-stores/${created.body.id}`)
        .send({ duplicate_threshold: null, supersede_threshold: null });

      expect(response.status).toBe(200);
      expect(response.body.duplicate_threshold).toBeNull();
      expect(response.body.supersede_threshold).toBeNull();
    });
  });
});
