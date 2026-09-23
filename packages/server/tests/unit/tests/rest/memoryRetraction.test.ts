import { db } from 'src/db';
import * as eventBusModule from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const MEMORY_ACTIONS = [
  'memories:CreateMemoryStore',
  'memories:GetMemoryStore',
  'memories:CreateMemory',
  'memories:GetMemory',
  'memories:ListMemories',
  'memories:UpdateMemory',
  'memories:RetractMemory',
  'memories:ListMemoryAssertions',
  'knowledge:SearchKnowledge',
];

/**
 * Retraction is an invalidation with no successor: the fact stops holding
 * without a replacement taking its place. It reuses `invalidated_at` rather
 * than adding a second marker, so every reader that already filters validity
 * excludes a retracted fact with nothing new to keep in sync.
 */
describe('Memory retraction', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memretract',
      policyActions: MEMORY_ACTIONS,
    });

    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  }, 60_000);

  /**
   * A store per test: the stub embedder answers every input with the same
   * vector, so two memories sharing a store score 1.0 against each other and a
   * seed left by another test would absorb this one's write.
   */
  const createStore = async (): Promise<string> => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: `Retract ${crypto.randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  const write = async (args: { storeId: string; content: string }) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({ memory_store_id: args.storeId, content: args.content });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  const retract = (args: { id: string; body?: object; token?: string }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post(`/api/v1/memories/${args.id}/retract`)
      .send(args.body ?? {});
  };

  const listIds = async (args: { storeId: string; query?: string }) => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/memories?memory_store_id=${args.storeId}${args.query ?? ''}`
    );
    expect(response.status).toBe(200);
    return (response.body.data as { id: string }[]).map((entry) => {
      return entry.id;
    });
  };

  describe('POST /api/v1/memories/:memory_id/retract', () => {
    test('invalidates the memory without naming a successor', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The office is in Lisbon' });

      const response = await retract({ id });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(id);
      expect(response.body.invalidated_at).not.toBeNull();
      expect(response.body.superseded_by_memory_id).toBeNull();
    });

    test('claims the version counter, so a stale write is refused', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'Invoices are paid net 30' });

      const response = await retract({ id });
      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });

    test('takes the memory out of the default listing', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The team ships on Fridays' });

      expect(await listIds({ storeId })).toContain(id);
      expect((await retract({ id })).status).toBe(200);

      expect(await listIds({ storeId })).not.toContain(id);
      expect(
        await listIds({ storeId, query: '&include_invalidated=true' })
      ).toContain(id);
    });

    test('leaves the memory readable by id', async () => {
      const storeId = await createStore();
      const id = await write({
        storeId,
        content: 'The vendor invoices in EUR',
      });
      expect((await retract({ id })).status).toBe(200);

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.content).toBe('The vendor invoices in EUR');
    });

    test('records an assertion with the retracted outcome', async () => {
      const storeId = await createStore();
      const id = await write({
        storeId,
        content: 'Support answers in English',
      });
      expect((await retract({ id })).status).toBe(200);

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${id}/assertions`
      );

      expect(response.status).toBe(200);
      const outcomes = (response.body.data as { outcome: string }[]).map(
        (assertion) => {
          return assertion.outcome;
        }
      );
      expect(outcomes).toEqual(['created', 'retracted']);

      const retraction = response.body.data[1];
      expect(retraction.memory_id).toBe(id);
      expect(retraction.superseded_memory_id).toBeNull();
      expect(retraction.mechanism).toBe('api');
      expect(retraction.similarity).toBeNull();
      expect(retraction.declared).toBe(false);
      expect(retraction.content).toBe('Support answers in English');
    });

    test('is never a dedup candidate again', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The office is in Lisbon' });
      expect((await retract({ id })).status).toBe(200);

      const restated = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeId,
          content: 'The office is in Lisbon',
        });

      expect(restated.status).toBe(201);
      expect(restated.body.action).toBe('created');
      expect(restated.body.id).not.toBe(id);
    });

    test('leaves knowledge search', async () => {
      const storeId = await createStore();
      const id = await write({
        storeId,
        content: 'Deliveries pause in August',
      });

      const memoryHits = async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/knowledge/search')
          .send({ project_id: projectId, memory_store_ids: [storeId] });
        expect(response.status).toBe(200);
        return (response.body.results as { source_type: string }[]).filter(
          (result) => {
            return result.source_type === 'memory';
          }
        );
      };

      expect(await memoryHits()).toHaveLength(1);
      expect((await retract({ id })).status).toBe(200);
      expect(await memoryHits()).toHaveLength(0);
    });

    test('refuses a memory that is already invalidated', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The warehouse is in Porto' });
      expect((await retract({ id })).status).toBe(200);

      const response = await retract({ id });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('MEMORY_ALREADY_INVALIDATED');
    });

    test('refuses a memory a supersede already retired', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The plan renews yearly' });
      const replaced = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeId,
          content: 'The plan renews monthly',
          supersedes: id,
        });
      expect(replaced.status).toBe(200);
      expect(replaced.body.action).toBe('superseded');

      const response = await retract({ id });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('MEMORY_ALREADY_INVALIDATED');
    });

    test('honours the version the caller states', async () => {
      const storeId = await createStore();
      const id = await write({
        storeId,
        content: 'Returns close after 14 days',
      });

      const stale = await retract({ id, body: { expected_version: 7 } });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(stale.body.error.meta.current_version).toBe(1);

      const current = await retract({ id, body: { expected_version: 1 } });
      expect(current.status).toBe(200);
    });

    test('honours the version an If-Match header states', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'Tickets are refundable' });

      const stale = await authenticatedTestClient(userToken)
        .post(`/api/v1/memories/${id}/retract`)
        .set('If-Match', '"9"')
        .send({});
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');

      const current = await authenticatedTestClient(userToken)
        .post(`/api/v1/memories/${id}/retract`)
        .set('If-Match', '"1"')
        .send({});
      expect(current.status).toBe(200);
    });

    test('a retraction is not a supersede link on the assertion ledger', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The key rotates quarterly' });
      expect((await retract({ id })).status).toBe(200);

      const entry = await db.Memory.findOne({ where: { publicId: id } });
      expect(entry!.supersededByMemoryId).toBeNull();
      expect(entry!.invalidatedAt).not.toBeNull();
    });

    test('announces the retraction on the event bus', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'The API rate limit is 60' });

      const events: eventBusModule.SoatEvent[] = [];
      const listener = (event: eventBusModule.SoatEvent) => {
        events.push(event);
      };
      eventBusModule.eventBus.on('soat:event', listener);

      try {
        expect((await retract({ id })).status).toBe(200);

        // The envelope resolves the project's public id with a real read, so
        // the event can land a tick or two after the request returned — and
        // after events this test's own setup emitted, so wait for this one.
        const retracted = () => {
          return events.some((event) => {
            return event.type === 'memories.retracted';
          });
        };
        for (let i = 0; i < 100 && !retracted(); i += 1) {
          await new Promise((resolve) => {
            return setTimeout(resolve, 20);
          });
        }
      } finally {
        eventBusModule.eventBus.off('soat:event', listener);
      }

      const retraction = events.find((event) => {
        return event.type === 'memories.retracted';
      });
      expect(retraction).toBeDefined();
      expect(retraction!.resourceId).toBe(id);
    });

    test('401 without authentication', async () => {
      const storeId = await createStore();
      const id = await write({ storeId, content: 'Anyone may read this' });

      const response = await testClient
        .post(`/api/v1/memories/${id}/retract`)
        .send({});

      expect(response.status).toBe(401);
    });

    test('403 without the action', async () => {
      const storeId = await createStore();
      const id = await write({
        storeId,
        content: 'Only the grantee may retract',
      });

      const response = await retract({ id, token: noPermToken });

      expect(response.status).toBe(403);
    });

    test('404 for a memory that does not exist', async () => {
      const response = await retract({ id: 'mem_doesnotexist' });

      expect(response.status).toBe(404);
    });
  });
});
