import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { setMemorySimilarity } from '../../fixtures/memoryWrites';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('MemoryStores', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memory_stores',
      policyActions: [
        'memories:ListMemoryStores',
        'memories:CreateMemoryStore',
        'memories:GetMemoryStore',
        'memories:UpdateMemoryStore',
        'memories:DeleteMemoryStore',
        'memories:ListMemories',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:UpdateMemory',
        'memories:DeleteMemory',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;
  });

  describe('POST /api/v1/memory-stores', () => {
    test('authenticated user with permission can create a memoryStore', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Test MemoryStore',
          description: 'A test memoryStore',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^mstore_/);
      expect(response.body.name).toBe('Test MemoryStore');
      expect(response.body.description).toBe('A test memoryStore');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('can create a memoryStore with tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Tagged MemoryStore',
          tags: { project: 'A', team: 'customer-support' },
        });

      expect(response.status).toBe(201);
      expect(response.body.tags).toEqual({
        project: 'A',
        team: 'customer-support',
      });
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
        });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/memory-stores').send({
        project_id: projectId,
        name: 'Test MemoryStore',
      });

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Test MemoryStore',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/memory-stores', () => {
    test('authenticated user can list memoryStores', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/memory-stores');
      expect(response.status).toBe(401);
    });

    test('user without access to project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('admin without project scoping gets an empty list', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/memory-stores'
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('GET /api/v1/memory-stores/:memory_store_id', () => {
    let memoryStoreId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Get Test MemoryStore',
        });
      memoryStoreId = res.body.id;
    });

    test('authenticated user can get a memoryStore', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${memoryStoreId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(memoryStoreId);
      expect(response.body.name).toBe('Get Test MemoryStore');
    });

    test('returns 404 for non-existent memoryStore', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/memory-stores/mstore_nonexistent0000'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/memory-stores/${memoryStoreId}`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memory-stores/${memoryStoreId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/v1/memory-stores/:memory_store_id', () => {
    let memoryStoreId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Update Test MemoryStore',
        });
      memoryStoreId = res.body.id;
    });

    test('updates description only', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memory-stores/${memoryStoreId}`)
        .send({ description: 'Updated description' });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Updated description');
    });

    test('authenticated user can update a memoryStore name', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memory-stores/${memoryStoreId}`)
        .send({
          name: 'Updated MemoryStore Name',
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(memoryStoreId);
      expect(response.body.name).toBe('Updated MemoryStore Name');
    });

    test('returns 404 for non-existent memoryStore', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/memory-stores/mstore_nonexistent0000')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/memory-stores/${memoryStoreId}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/memory-stores/${memoryStoreId}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/memory-stores/:memory_store_id', () => {
    test('authenticated user can delete a memoryStore', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Delete Test MemoryStore',
        });
      const deleteMemId = createRes.body.id;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/memory-stores/${deleteMemId}`
      );

      expect(response.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/memory-stores/${deleteMemId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('returns 404 for non-existent memoryStore', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/memory-stores/mstore_nonexistent0000'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Auth Delete Test',
        });
      const tempMemId = createRes.body.id;

      const response = await testClient.delete(
        `/api/v1/memory-stores/${tempMemId}`
      );

      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Perm Delete Test',
        });
      const tempMemId = createRes.body.id;

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/memory-stores/${tempMemId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Memories', () => {
    let memoryStoreId: string;

    const createTestMemoryStore = async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: `Test MemoryStore ${Date.now()}`,
        });
      return res.body.id as string;
    };

    beforeAll(async () => {
      memoryStoreId = await createTestMemoryStore();
    });

    describe('POST /api/v1/memories', () => {
      test('authenticated user can create a memory', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Customer prefers email over phone',
          });

        expect(response.status).toBe(201);
        expect(response.body.id).toBeDefined();
        expect(response.body.id).toMatch(/^mem_/);
        expect(response.body.content).toBe('Customer prefers email over phone');
        expect(response.body.source_type).toBe('manual');
        expect(response.body.memory_store_id).toBe(freshMemoryStoreId);
        expect(response.body.created_at).toBeDefined();
        expect(response.body.action).toBe('created');
      });

      test('can create a memory sourced from a conversation', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Learned in a conversation',
            source_type: 'conversation',
            source_id: 'conv_source_01',
          });

        expect(response.status).toBe(201);
        expect(response.body.source_type).toBe('conversation');
        expect(response.body.source_id).toBe('conv_source_01');
        expect(response.body.action).toBe('created');
      });

      test('returns 400 when source_type is conversation without source_id', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Missing its source',
            source_type: 'conversation',
          });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });

      test('returns 400 when source_id is given without a conversation source_type', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Points nowhere',
            source_id: 'conv_source_01',
          });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });

      test('returns 400 when content is missing', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({ memory_store_id: memoryStoreId });

        expect(response.status).toBe(400);
      });

      test('returns 404 for non-existent memoryStore', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({ memory_store_id: 'mstore_nonexistent0000', content: 'test' });

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient
          .post('/api/v1/memories')
          .send({ memory_store_id: memoryStoreId, content: 'test' });

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken)
          .post('/api/v1/memories')
          .send({ memory_store_id: memoryStoreId, content: 'test' });

        expect(response.status).toBe(403);
      });

      test('second write to same memoryStore is skipped (duplicate)', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        await authenticatedTestClient(userToken).post('/api/v1/memories').send({
          memory_store_id: freshMemoryStoreId,
          content: 'First entry',
        });

        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Second entry same memoryStore',
          });

        expect(response.status).toBe(200);
        expect(response.body.action).toBe('skipped');
        expect(response.body.id).toMatch(/^mem_/);
      });

      // The supersede band retires the matched memory intact and replaces it
      // with a new one. Nothing is rewritten or merged, so neither original
      // text is lost.
      test('a supersede-band write retires the match and replaces it', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const first = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Delivery window is two weeks',
          });
        await setMemorySimilarity({
          memoryId: first.body.id as string,
          similarity: 0.92,
        });

        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Delivery window is four weeks',
          });

        expect(response.status).toBe(200);
        expect(response.body.action).toBe('superseded');
        expect(response.body.id).not.toBe(first.body.id);
        expect(response.body.content).toBe('Delivery window is four weeks');
        expect(response.body.invalidated_at).toBeNull();

        // The retired entry keeps its own text and points at its replacement.
        const existing = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${first.body.id}`
        );
        expect(existing.body.content).toBe('Delivery window is two weeks');
        expect(existing.body.invalidated_at).not.toBeNull();
        expect(existing.body.superseded_by_memory_id).toBe(response.body.id);
      });

      test('a threshold outside [0, 1] returns 400', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Out of range threshold',
            duplicate_threshold: 1.1,
          });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });

      // Equal makes `superseded` unreachable and inverted swallows `skipped`,
      // so either way one of the three outcomes silently stops occurring.
      test('a threshold pair that is not supersede < duplicate returns 400', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Inverted thresholds',
            duplicate_threshold: 0.8,
            supersede_threshold: 0.9,
          });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });

      // The check runs against the effective pair, so a body that overrides one
      // value cannot invert it against the store's other one.
      test('a one-sided override that inverts the store pair returns 400', async () => {
        const storeRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memory-stores')
          .send({
            project_id: projectId,
            name: `Effective Pair ${Date.now()}`,
            duplicate_threshold: 0.9,
            supersede_threshold: 0.8,
          });

        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: storeRes.body.id,
            content: 'One-sided override',
            // Below the store's supersede_threshold of 0.8.
            duplicate_threshold: 0.7,
          });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });

      test('update_threshold is rejected as an unknown field', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Threshold entry',
            update_threshold: 0.5,
          });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });

      test('can create an entry with tags and metadata', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Approve refunds under $50 automatically',
            tags: { role: 'traffic-manager', source: 'rejected_approval' },
            metadata: { action_id: 'act_01', evidence: 'high' },
          });

        expect(response.status).toBe(201);
        expect(response.body.action).toBe('created');
        expect(response.body.tags).toEqual({
          role: 'traffic-manager',
          source: 'rejected_approval',
        });
        expect(response.body.metadata).toEqual({
          action_id: 'act_01',
          evidence: 'high',
        });
      });

      test('entry created without tags/metadata returns null for both', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: freshMemoryStoreId,
            content: 'Untagged entry',
          });

        expect(response.status).toBe(201);
        expect(response.body.tags).toBeNull();
        expect(response.body.metadata).toBeNull();
      });

      test('returns 400 when tags is not an object of strings', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: memoryStoreId,
            content: 'x',
            tags: ['a', 'b'],
          });

        expect(response.status).toBe(400);
        expect(response.body.error.message).toMatch(/tags/);
      });

      test('returns 400 when metadata is not an object', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: memoryStoreId,
            content: 'x',
            metadata: 'nope',
          });

        expect(response.status).toBe(400);
        expect(response.body.error.message).toMatch(/metadata/);
      });
    });

    describe('GET /api/v1/memories', () => {
      test('authenticated user can list entries', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories?memory_store_id=${memoryStoreId}`
        );

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body.data)).toBe(true);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/memories?memory_store_id=${memoryStoreId}`
        );

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/memories?memory_store_id=${memoryStoreId}`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('GET /api/v1/memories/:memory_id', () => {
      let entryId: string;
      let getEntryMemoryStoreId: string;

      beforeAll(async () => {
        getEntryMemoryStoreId = await createTestMemoryStore();
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: getEntryMemoryStoreId,
            content: 'Entry to get',
          });
        entryId = res.body.id;
      });

      test('authenticated user can get an entry', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${entryId}`
        );

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(entryId);
        expect(response.body.content).toBe('Entry to get');
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/me_nonexistent00000`
        );

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(`/api/v1/memories/${entryId}`);

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/memories/${entryId}`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('PUT /api/v1/memories/:memory_id', () => {
      let entryId: string;
      let putEntryMemoryStoreId: string;

      beforeAll(async () => {
        putEntryMemoryStoreId = await createTestMemoryStore();
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: putEntryMemoryStoreId,
            content: 'Entry to update',
          });
        entryId = res.body.id;
      });

      test('authenticated user can update an entry', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memories/${entryId}`)
          .send({ content: 'Updated content' });

        expect(response.status).toBe(200);
        expect(response.body.content).toBe('Updated content');
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memories/me_nonexistent00000`)
          .send({ content: 'x' });

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient
          .put(`/api/v1/memories/${entryId}`)
          .send({ content: 'x' });

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const response = await authenticatedTestClient(noPermToken)
          .put(`/api/v1/memories/${entryId}`)
          .send({ content: 'x' });

        expect(response.status).toBe(403);
      });

      test('can set and then clear tags/metadata', async () => {
        const memId = await createTestMemoryStore();
        const created = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({ memory_store_id: memId, content: 'Taggable entry' });
        const id = created.body.id;

        const set = await authenticatedTestClient(userToken)
          .put(`/api/v1/memories/${id}`)
          .send({ tags: { role: 'pilot' }, metadata: { k: 'v' } });
        expect(set.status).toBe(200);
        expect(set.body.tags).toEqual({ role: 'pilot' });
        expect(set.body.metadata).toEqual({ k: 'v' });

        const cleared = await authenticatedTestClient(userToken)
          .put(`/api/v1/memories/${id}`)
          .send({ tags: null, metadata: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.tags).toBeNull();
        expect(cleared.body.metadata).toBeNull();
      });

      test('returns 400 when tags is invalid', async () => {
        const response = await authenticatedTestClient(userToken)
          .put(`/api/v1/memories/${entryId}`)
          .send({ tags: { role: 1 } });

        expect(response.status).toBe(400);
        expect(response.body.error.message).toMatch(/tags/);
      });

      describe('write precondition', () => {
        const createMemory = async (): Promise<string> => {
          const memId = await createTestMemoryStore();
          const created = await authenticatedTestClient(userToken)
            .post('/api/v1/memories')
            .send({ memory_store_id: memId, content: 'Precondition source' });
          expect(created.status).toBe(201);
          return created.body.id;
        };

        test('a write naming the current version is applied', async () => {
          const id = await createMemory();

          const response = await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${id}`)
            .send({ content: 'v2', expected_version: 1 });

          expect(response.status).toBe(200);
          expect(response.body.version).toBe(2);
        });

        test('a write naming a stale version is refused with the current one', async () => {
          const id = await createMemory();

          await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${id}`)
            .send({ content: 'v2' });

          const response = await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${id}`)
            .send({ content: 'v3', expected_version: 1 });

          expect(response.status).toBe(409);
          expect(response.body.error.code).toBe('VERSION_CONFLICT');
          expect(response.body.error.meta.current_version).toBe(2);
          expect(response.body.error.meta.expected_version).toBe(1);
        });

        test('If-Match carries the same precondition', async () => {
          const id = await createMemory();

          const response = await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${id}`)
            .set('If-Match', '1')
            .send({ content: 'v2' });

          expect(response.status).toBe(200);
          expect(response.body.version).toBe(2);
        });

        test('a refused write leaves the memory untouched', async () => {
          const id = await createMemory();

          await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${id}`)
            .send({ content: 'v2' });

          await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${id}`)
            .send({ content: 'refused', expected_version: 1 });

          const after = await authenticatedTestClient(userToken).get(
            `/api/v1/memories/${id}`
          );
          expect(after.body.content).toBe('v2');
          expect(after.body.version).toBe(2);
        });
      });
    });

    describe('DELETE /api/v1/memories/:memory_id', () => {
      test('authenticated user can delete an entry', async () => {
        const deleteMemoryStoreId = await createTestMemoryStore();
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: deleteMemoryStoreId,
            content: 'Entry to delete',
          });
        const entryId = createRes.body.id;

        const response = await authenticatedTestClient(userToken).delete(
          `/api/v1/memories/${entryId}`
        );

        expect(response.status).toBe(204);

        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${entryId}`
        );
        expect(getRes.status).toBe(404);
      });

      test('returns 404 for non-existent entry', async () => {
        const response = await authenticatedTestClient(userToken).delete(
          `/api/v1/memories/me_nonexistent00000`
        );

        expect(response.status).toBe(404);
      });

      test('unauthenticated request returns 401', async () => {
        const deleteMemoryStoreId = await createTestMemoryStore();
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: deleteMemoryStoreId,
            content: 'Auth Delete Test Entry',
          });
        const entryId = createRes.body.id;

        const response = await testClient.delete(`/api/v1/memories/${entryId}`);

        expect(response.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const deleteMemoryStoreId = await createTestMemoryStore();
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: deleteMemoryStoreId,
            content: 'Perm Delete Test Entry',
          });
        const entryId = createRes.body.id;

        const response = await authenticatedTestClient(noPermToken).delete(
          `/api/v1/memories/${entryId}`
        );

        expect(response.status).toBe(403);
      });
    });

    describe('provenance and temporal invalidation', () => {
      const createEntry = async (args: {
        memoryStoreId: string;
        content: string;
        sourceType?: string;
      }) => {
        return authenticatedTestClient(userToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: args.memoryStoreId,
            content: args.content,
            source_type: args.sourceType,
          });
      };

      // Retirement with no replacement — a "forget this" — has no writer yet,
      // so the state is seeded directly. The supersede case below is produced
      // by the write path itself.
      const invalidateEntry = async (args: { entryId: string }) => {
        const entry = await db.Memory.findOne({
          where: { publicId: args.entryId },
        });
        entry!.invalidatedAt = new Date();
        await entry!.save();
      };

      test('a manual REST write records no provenance', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Manually written fact',
        });

        expect(response.status).toBe(201);
        expect(response.body.source_type).toBe('manual');
        expect(response.body.source_id).toBeNull();
      });

      test('a newly created entry is valid', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const response = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'A currently valid fact',
        });

        expect(response.status).toBe(201);
        expect(response.body.invalidated_at).toBeNull();
        expect(response.body.superseded_by_memory_id).toBeNull();
      });

      test('listing excludes invalidated entries by default', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const retired = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Fact that gets retired',
        });
        await invalidateEntry({ entryId: retired.body.id });

        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories?memory_store_id=${freshMemoryStoreId}`
        );

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(0);
        expect(response.body.total).toBe(0);
      });

      // The state here is produced by the write path itself rather than seeded:
      // a supersede is the one thing that fills both columns at once.
      test('include_invalidated returns invalidated entries with their supersede link', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const oldEntry = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Pedro works at Company X',
        });
        await setMemorySimilarity({
          memoryId: oldEntry.body.id as string,
          similarity: 0.92,
        });

        const replacement = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Pedro left Company X',
        });
        expect(replacement.body.action).toBe('superseded');

        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories?memory_store_id=${freshMemoryStoreId}&include_invalidated=true`
        );

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(2);
        const retired = response.body.data.find((e: { id: string }) => {
          return e.id === oldEntry.body.id;
        });
        expect(retired.invalidated_at).toBeDefined();
        expect(retired.invalidated_at).not.toBeNull();
        expect(retired.superseded_by_memory_id).toBe(replacement.body.id);
      });

      test('an invalidated entry is still readable by id for audit', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const retired = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Retired but auditable',
        });
        await invalidateEntry({ entryId: retired.body.id });

        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/memories/${retired.body.id}`
        );

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(retired.body.id);
        expect(response.body.invalidated_at).not.toBeNull();
      });

      test('an invalidated entry is not a dedup candidate', async () => {
        const freshMemoryStoreId = await createTestMemoryStore();
        const original = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Original fact',
        });
        expect(original.body.action).toBe('created');

        // Baseline: while the entry is valid, the next write dedups against it
        // (constant test embeddings score 1.0).
        const beforeInvalidation = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Second fact',
        });
        expect(beforeInvalidation.body.action).toBe('skipped');

        await invalidateEntry({ entryId: original.body.id });

        const afterInvalidation = await createEntry({
          memoryStoreId: freshMemoryStoreId,
          content: 'Third fact, written after invalidation',
        });

        expect(afterInvalidation.status).toBe(201);
        expect(afterInvalidation.body.action).toBe('created');
      });
    });
  });

  describe('GET /api/v1/memory-stores with tag filter', () => {
    let taggedMemoryStoreId: string;
    let prefixedMemoryStoreId: string;
    let untaggedMemoryStoreId: string;

    beforeAll(async () => {
      const taggedRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Tagged MemoryStore Alpha',
          tags: { team: 'customer-support', system: 'crm' },
        });
      taggedMemoryStoreId = taggedRes.body.id;

      const prefixedRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Tagged MemoryStore Beta',
          tags: { team: 'customer-support', system: 'prefs' },
        });
      prefixedMemoryStoreId = prefixedRes.body.id;

      const untaggedRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Untagged MemoryStore',
        });
      untaggedMemoryStoreId = untaggedRes.body.id;
    });

    test('a single key:value pair returns only memoryStores carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId, tags: 'system:crm' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryStoreId);
      expect(ids).not.toContain(prefixedMemoryStoreId);
      expect(ids).not.toContain(untaggedMemoryStoreId);
    });

    test('a shared pair matches every memoryStore carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId, tags: 'team:customer-support' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryStoreId);
      expect(ids).toContain(prefixedMemoryStoreId);
      expect(ids).not.toContain(untaggedMemoryStoreId);
    });

    test('multiple pairs are ANDed', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({
          project_id: projectId,
          tags: ['team:customer-support', 'system:crm'],
        });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryStoreId);
      expect(ids).not.toContain(prefixedMemoryStoreId);
      expect(ids).not.toContain(untaggedMemoryStoreId);
    });

    test('matches values exactly and case-sensitively', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId, tags: 'system:CRM' });

      expect(response.status).toBe(200);
      expect(
        response.body.data.map((m: { id: string }) => {
          return m.id;
        })
      ).not.toContain(taggedMemoryStoreId);
    });

    test('returns 400 for a pair missing its colon', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId, tags: 'crm' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/key:value/);
    });

    test('keeps colons inside a tag value', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Colon Value MemoryStore',
          tags: { url: 'https://example.com/a' },
        });

      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId, tags: 'url:https://example.com/a' });

      expect(response.status).toBe(200);
      expect(
        response.body.data.map((m: { id: string }) => {
          return m.id;
        })
      ).toContain(created.body.id);
    });

    test('a pair with no match returns an empty array', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId, tags: 'system:nonexistent-xyz' });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).not.toContain(taggedMemoryStoreId);
      expect(ids).not.toContain(prefixedMemoryStoreId);
      expect(ids).not.toContain(untaggedMemoryStoreId);
    });

    test('no tags filter returns all memoryStores', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/memory-stores')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((m: { id: string }) => {
        return m.id;
      });
      expect(ids).toContain(taggedMemoryStoreId);
      expect(ids).toContain(prefixedMemoryStoreId);
      expect(ids).toContain(untaggedMemoryStoreId);
    });
  });
});
