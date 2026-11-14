import * as eventBusModule from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const MEMORY_ACTIONS = [
  'memories:CreateMemoryStore',
  'memories:CreateMemory',
  'memories:GetMemory',
  'memories:UpdateMemory',
];

/**
 * Every memory write announces itself, so a trigger can react to a memory the
 * way it reacts to a document: `memories.created` when a row is stored (a
 * supersede stores its replacement), `memories.updated` when one changes, and
 * nothing when the write stored nothing.
 */
describe('Memory write events', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memevents',
      policyActions: MEMORY_ACTIONS,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  }, 60_000);

  /**
   * A store per test: the stub embedder answers every input with the same
   * vector, so a second write into one store scores 1.0 against the first.
   */
  const createStore = async (): Promise<string> => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: `Events ${crypto.randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  /** `201` stores a new memory; a supersede or a skip answers `200`. */
  const write = async (body: Record<string, unknown>, status = 201) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send(body);
    expect(response.status).toBe(status);
    return response.body as { id: string; action?: string };
  };

  /**
   * Runs `act` and collects the memory events for `resourceIds` until `until`
   * holds. The envelope resolves the project's public id with a real read, so
   * an event lands after the request returns; the promise settles on the
   * event itself, never on a timer.
   */
  const memoryEventsDuring = async (args: {
    act: () => Promise<unknown>;
    until: (events: eventBusModule.SoatEvent[]) => boolean;
  }): Promise<eventBusModule.SoatEvent[]> => {
    const events: eventBusModule.SoatEvent[] = [];
    let settle: () => void = () => {};
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      settle = resolve;
      deadline = setTimeout(() => {
        reject(
          new Error(
            `expected memory events never arrived; saw ${JSON.stringify(
              events.map((event) => {
                return event.type;
              })
            )}`
          )
        );
      }, 10_000);
    });
    const listener = (event: eventBusModule.SoatEvent) => {
      if (!event.type.startsWith('memories.')) return;
      events.push(event);
      if (args.until(events)) settle();
    };
    eventBusModule.eventBus.on('soat:event', listener);
    try {
      await args.act();
      // An event can arrive before `act` learned the id `until` looks for.
      if (args.until(events)) settle();
      await settled;
    } finally {
      clearTimeout(deadline);
      eventBusModule.eventBus.off('soat:event', listener);
    }
    return events;
  };

  const ofType = (events: eventBusModule.SoatEvent[], type: string) => {
    return events.filter((event) => {
      return event.type === type;
    });
  };

  describe('POST /api/v1/memories', () => {
    test('a created memory emits memories.created with the memory', async () => {
      const storeId = await createStore();
      let createdId = '';

      const events = await memoryEventsDuring({
        act: async () => {
          createdId = (
            await write({
              memory_store_id: storeId,
              content: 'The office is in Lisbon',
              tags: { team: 'ops' },
            })
          ).id;
        },
        until: (seen) => {
          return ofType(seen, 'memories.created').length > 0;
        },
      });

      const [created] = ofType(events, 'memories.created');
      expect(created.resourceType).toBe('memory');
      expect(created.resourceId).toBe(createdId);
      expect(created.data).toMatchObject({
        id: createdId,
        tags: { team: 'ops' },
      });
    });

    test('a supersede emits memories.created for the replacement', async () => {
      const storeId = await createStore();
      const original = await write({
        memory_store_id: storeId,
        content: 'The office is in Lisbon',
      });
      let replacementId = '';

      const events = await memoryEventsDuring({
        act: async () => {
          replacementId = (
            await write(
              {
                memory_store_id: storeId,
                content: 'We closed the Lisbon office',
                supersedes: original.id,
              },
              200
            )
          ).id;
        },
        until: (seen) => {
          return ofType(seen, 'memories.created').length > 0;
        },
      });

      expect(replacementId).not.toBe(original.id);
      expect(
        ofType(events, 'memories.created').map((event) => {
          return event.resourceId;
        })
      ).toEqual([replacementId]);
    });

    test('a deduplicated write emits nothing', async () => {
      const storeId = await createStore();
      const original = await write({
        memory_store_id: storeId,
        content: 'The API rate limit is 60',
      });

      // A marker write into a second store is the event that ends the wait: by
      // then any event the skipped write would have emitted is on the bus too.
      const markerStoreId = await createStore();
      let markerId = '';
      const events = await memoryEventsDuring({
        act: async () => {
          const skipped = await write(
            { memory_store_id: storeId, content: 'The API rate limit is 60' },
            200
          );
          expect(skipped.id).toBe(original.id);
          markerId = (
            await write({ memory_store_id: markerStoreId, content: 'Marker' })
          ).id;
        },
        until: (seen) => {
          return seen.some((event) => {
            return event.resourceId === markerId;
          });
        },
      });

      expect(
        events.filter((event) => {
          return event.resourceId === original.id;
        })
      ).toEqual([]);
    });
  });

  describe('PUT /api/v1/memories/:memory_id', () => {
    test('an update emits memories.updated with the updated memory', async () => {
      const storeId = await createStore();
      const original = await write({
        memory_store_id: storeId,
        content: 'The office is in Lisbon',
      });

      const events = await memoryEventsDuring({
        act: async () => {
          const response = await authenticatedTestClient(userToken)
            .put(`/api/v1/memories/${original.id}`)
            .send({ content: 'The office is in Porto' });
          expect(response.status).toBe(200);
        },
        until: (seen) => {
          return ofType(seen, 'memories.updated').length > 0;
        },
      });

      const [updated] = ofType(events, 'memories.updated');
      expect(updated.resourceId).toBe(original.id);
      expect(updated.data).toMatchObject({
        id: original.id,
        content: 'The office is in Porto',
      });
    });
  });

  describe('PATCH /api/v1/memories/:memory_id/tags', () => {
    test('a tag write emits memories.updated carrying the new tags', async () => {
      const storeId = await createStore();
      const original = await write({
        memory_store_id: storeId,
        content: 'The office is in Lisbon',
      });

      const events = await memoryEventsDuring({
        act: async () => {
          const response = await authenticatedTestClient(userToken)
            .patch(`/api/v1/memories/${original.id}/tags`)
            .send({ screened: 'clean' });
          expect(response.status).toBe(200);
        },
        until: (seen) => {
          return ofType(seen, 'memories.updated').length > 0;
        },
      });

      const [updated] = ofType(events, 'memories.updated');
      expect(updated.resourceId).toBe(original.id);
      expect(updated.data).toMatchObject({ tags: { screened: 'clean' } });
    });
  });
});
