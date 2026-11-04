import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `?memory_store_id` on a `/memories/{memory_id}` route pins the call to one
 * store: a memory of another store is `404`. The same name filters the
 * listing, so one preset confines every memory operation a tool makes.
 */
describe('Memories pinned to a memory_store_id', () => {
  let userToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createStore = async (): Promise<string> => {
    const res = await client()
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: `Pin ${crypto.randomUUID()}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const write = async (storeId: string): Promise<string> => {
    const res = await client()
      .post('/api/v1/memories')
      .send({
        memory_store_id: storeId,
        content: `fact ${crypto.randomUUID()}`,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'mempin',
      policyActions: [
        'memories:CreateMemoryStore',
        'memories:GetMemoryStore',
        'memories:CreateMemory',
        'memories:GetMemory',
        'memories:ListMemories',
        'memories:UpdateMemory',
        'memories:DeleteMemory',
        'memories:RetractMemory',
        'memories:ListMemoryAssertions',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  }, 60_000);

  /**
   * A fresh store per memory: the stub embedder answers every input with the
   * same vector, so a second write into one store is absorbed as a duplicate.
   */
  const memoryIn = async (): Promise<{ id: string; storeId: string }> => {
    const storeId = await createStore();
    return { id: await write(storeId), storeId };
  };

  const routes: Array<{
    name: string;
    call: (id: string, query: string) => Promise<{ status: number }>;
  }> = [
    {
      name: 'GET /memories/{id}',
      call: (id, query) => {
        return client().get(`/api/v1/memories/${id}${query}`);
      },
    },
    {
      name: 'PUT /memories/{id}',
      call: (id, query) => {
        return client()
          .put(`/api/v1/memories/${id}${query}`)
          .send({ metadata: { edited: true } });
      },
    },
    {
      name: 'DELETE /memories/{id}',
      call: (id, query) => {
        return client().delete(`/api/v1/memories/${id}${query}`);
      },
    },
    {
      name: 'POST /memories/{id}/retract',
      call: (id, query) => {
        return client().post(`/api/v1/memories/${id}/retract${query}`).send({});
      },
    },
    {
      name: 'GET /memories/{id}/assertions',
      call: (id, query) => {
        return client().get(`/api/v1/memories/${id}/assertions${query}`);
      },
    },
    {
      name: 'GET /memories/{id}/tags',
      call: (id, query) => {
        return client().get(`/api/v1/memories/${id}/tags${query}`);
      },
    },
    {
      name: 'PUT /memories/{id}/tags',
      call: (id, query) => {
        return client()
          .put(`/api/v1/memories/${id}/tags${query}`)
          .send({ owner: 'alice' });
      },
    },
  ];

  describe.each(routes)('$name', ({ call }) => {
    test('reaches a memory of the pinned store', async () => {
      const memory = await memoryIn();
      const res = await call(memory.id, `?memory_store_id=${memory.storeId}`);
      expect(res.status).toBeLessThan(300);
    });

    test('answers 404 for a memory of another store', async () => {
      const res = await call(
        (await memoryIn()).id,
        `?memory_store_id=${await createStore()}`
      );
      expect(res.status).toBe(404);
    });

    test('reaches any memory without a pin', async () => {
      const res = await call((await memoryIn()).id, '');
      expect(res.status).toBeLessThan(300);
    });
  });

  test('a refused update leaves the memory as it was', async () => {
    const { id } = await memoryIn();
    await client()
      .put(`/api/v1/memories/${id}?memory_store_id=${await createStore()}`)
      .send({ content: 'overwritten' });

    const res = await client().get(`/api/v1/memories/${id}`);
    expect(res.body.content).not.toBe('overwritten');
  });

  test('a repeated pin is refused rather than dropped', async () => {
    const memory = await memoryIn();
    const res = await client().get(
      `/api/v1/memories/${memory.id}?memory_store_id=${await createStore()}&memory_store_id=${memory.storeId}`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
