import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A memory belongs to the actor it was written for; its store belongs to no
 * one. Every read of a store's memories narrows to one actor when the call
 * names one. The stub embedder answers every text with one vector, so any two
 * memories a write compares are duplicates of each other.
 */
describe('Memory actors', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let actorA: string;
  let actorB: string;
  let otherProjectActor: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const newStore = async (): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: `actors ${crypto.randomUUID()}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const write = (body: Record<string, unknown>) => {
    return asAdmin().post('/api/v1/memories').send(body);
  };

  const idsOf = (rows: Array<{ id: string }>) => {
    return rows
      .map((row) => {
        return row.id;
      })
      .sort();
  };

  /** A store holding one memory of each owner: A, B and nobody. */
  const seeded = async () => {
    const storeId = await newStore();
    const ids: Record<'a' | 'b' | 'none', string> = {
      a: (
        await write({
          memory_store_id: storeId,
          content: 'A',
          actor_id: actorA,
        })
      ).body.id,
      b: (
        await write({
          memory_store_id: storeId,
          content: 'B',
          actor_id: actorB,
        })
      ).body.id,
      none: (await write({ memory_store_id: storeId, content: 'none' })).body
        .id,
    };
    return { storeId, ids };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memoryactors',
      policyActions: ['memories:GetMemory'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const actor = async (project: string, name: string) => {
      const res = await asAdmin()
        .post('/api/v1/actors')
        .send({ project_id: project, name });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    actorA = await actor(projectId, 'A');
    actorB = await actor(projectId, 'B');
    otherProjectActor = await actor(setup.otherProjectId!, 'Elsewhere');
  });

  describe('POST /api/v1/memories', () => {
    test('records the actor the memory belongs to', async () => {
      const res = await write({
        memory_store_id: await newStore(),
        content: 'Prefers email',
        actor_id: actorA,
      });
      expect(res.status).toBe(201);
      expect(res.body.actor_id).toBe(actorA);

      const read = await asAdmin().get(`/api/v1/memories/${res.body.id}`);
      expect(read.body.actor_id).toBe(actorA);
    });

    test('a memory written without one belongs to no actor', async () => {
      const res = await write({
        memory_store_id: await newStore(),
        content: 'Office in Lisbon',
      });
      expect(res.status).toBe(201);
      expect(res.body.actor_id).toBeNull();
    });

    test('an unknown actor is 400 ACTOR_NOT_FOUND', async () => {
      const res = await write({
        memory_store_id: await newStore(),
        content: 'x',
        actor_id: 'actor_doesNotExist',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
    });

    test("another project's actor is 400 ACTOR_NOT_FOUND", async () => {
      const res = await write({
        memory_store_id: await newStore(),
        content: 'x',
        actor_id: otherProjectActor,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
    });

    test('a fact already known for one actor is created for another', async () => {
      const storeId = await newStore();
      await write({
        memory_store_id: storeId,
        content: 'Likes tea',
        actor_id: actorA,
      });

      const res = await write({
        memory_store_id: storeId,
        content: 'Likes tea',
        actor_id: actorB,
      });

      expect(res.status).toBe(201);
      expect(res.body.action).toBe('created');
      expect(res.body.actor_id).toBe(actorB);
    });

    test('a fact known for an actor is created for no actor', async () => {
      const storeId = await newStore();
      await write({
        memory_store_id: storeId,
        content: 'Likes tea',
        actor_id: actorA,
      });

      const res = await write({
        memory_store_id: storeId,
        content: 'Likes tea',
      });

      expect(res.body.action).toBe('created');
    });

    test('a fact already known for the same actor is skipped', async () => {
      const storeId = await newStore();
      const first = await write({
        memory_store_id: storeId,
        content: 'Likes tea',
        actor_id: actorA,
      });

      const res = await write({
        memory_store_id: storeId,
        content: 'Likes tea',
        actor_id: actorA,
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped');
      expect(res.body.id).toBe(first.body.id);
    });

    test("supersedes naming another actor's memory is 400", async () => {
      const storeId = await newStore();
      const theirs = await write({
        memory_store_id: storeId,
        content: 'Office in Lisbon',
        actor_id: actorB,
      });

      const res = await write({
        memory_store_id: storeId,
        content: 'Office closed',
        actor_id: actorA,
        supersedes: theirs.body.id,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a replacement belongs to the actor of the memory it supersedes', async () => {
      const storeId = await newStore();
      const mine = await write({
        memory_store_id: storeId,
        content: 'Office in Lisbon',
        actor_id: actorA,
      });

      const res = await write({
        memory_store_id: storeId,
        content: 'Office closed',
        actor_id: actorA,
        supersedes: mine.body.id,
      });

      expect(res.body.action).toBe('superseded');
      expect(res.body.actor_id).toBe(actorA);
    });
  });

  describe('PUT /api/v1/memories/{memory_id}', () => {
    test('actor_id cannot be changed', async () => {
      const created = await write({
        memory_store_id: await newStore(),
        content: 'x',
        actor_id: actorA,
      });

      const res = await asAdmin()
        .put(`/api/v1/memories/${created.body.id}`)
        .send({ actor_id: actorB });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/memories', () => {
    test('actor_id lists only that actor’s memories', async () => {
      const { storeId, ids } = await seeded();

      const res = await asAdmin()
        .get('/api/v1/memories')
        .query({ memory_store_id: storeId, actor_id: actorA });

      expect(res.status).toBe(200);
      expect(idsOf(res.body.data)).toEqual([ids.a]);
    });

    test('without actor_id every memory is listed', async () => {
      const { storeId, ids } = await seeded();

      const res = await asAdmin()
        .get('/api/v1/memories')
        .query({ memory_store_id: storeId });

      expect(idsOf(res.body.data)).toEqual(
        idsOf([{ id: ids.a }, { id: ids.b }, { id: ids.none }])
      );
    });

    test('an unknown actor lists nothing', async () => {
      const { storeId } = await seeded();

      const res = await asAdmin()
        .get('/api/v1/memories')
        .query({ memory_store_id: storeId, actor_id: 'actor_doesNotExist' });

      expect(res.body.data).toEqual([]);
    });

    test('a repeated actor_id is 400', async () => {
      const { storeId } = await seeded();

      const res = await asAdmin().get(
        `/api/v1/memories?memory_store_id=${storeId}&actor_id=${actorA}&actor_id=${actorB}`
      );

      expect(res.status).toBe(400);
    });

    test('401 without credentials', async () => {
      const res = await testClient
        .get('/api/v1/memories')
        .query({ memory_store_id: 'mstore_x', actor_id: actorA });
      expect(res.status).toBe(401);
    });

    test('403 without ListMemories', async () => {
      const { storeId } = await seeded();
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/memories')
        .query({ memory_store_id: storeId, actor_id: actorA });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/memories/{memory_id} pinned to an actor', () => {
    test("the actor's own memory is reached", async () => {
      const { ids } = await seeded();

      const res = await asAdmin()
        .get(`/api/v1/memories/${ids.a}`)
        .query({ actor_id: actorA });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(ids.a);
    });
  });

  describe('GET /api/v1/memory-stores/{memory_store_id}/export', () => {
    test('actor_id exports only that actor’s memories', async () => {
      const { storeId, ids } = await seeded();

      const res = await asAdmin()
        .get(`/api/v1/memory-stores/${storeId}/export`)
        .query({ actor_id: actorA })
        .buffer(true)
        .parse((response, callback) => {
          let text = '';
          response.on('data', (chunk: Buffer) => {
            text += chunk.toString();
          });
          response.on('end', () => {
            callback(null, text);
          });
        });

      expect(res.status).toBe(200);
      const lines = String(res.body)
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          return JSON.parse(line) as { id: string };
        });
      expect(idsOf(lines)).toEqual([ids.a]);
    });
  });

  describe('GET /api/v1/memory-stores/{memory_store_id}/assertions', () => {
    test('actor_id lists only the writes into that actor’s memories', async () => {
      const { storeId, ids } = await seeded();

      const res = await asAdmin()
        .get(`/api/v1/memory-stores/${storeId}/assertions`)
        .query({ actor_id: actorA });

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { memory_id: string }) => {
          return row.memory_id;
        })
      ).toEqual([ids.a]);
    });
  });

  describe('POST /api/v1/knowledge/search', () => {
    test('actor_id searches only that actor’s memories', async () => {
      const { storeId, ids } = await seeded();

      const res = await asAdmin()
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_store_ids: [storeId],
          actor_id: actorA,
        });

      expect(res.status).toBe(200);
      expect(
        res.body.results.map((row: { memory_id: string }) => {
          return row.memory_id;
        })
      ).toEqual([ids.a]);
    });

    test('without actor_id every actor’s memories are searched', async () => {
      const { storeId } = await seeded();

      const res = await asAdmin()
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, memory_store_ids: [storeId] });

      expect(res.body.results).toHaveLength(3);
    });
  });
});
