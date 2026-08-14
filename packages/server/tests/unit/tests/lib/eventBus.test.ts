import { emitCustomEvent, eventBus, onEvent } from 'src/lib/eventBus';
import { isSoatEventType, SOAT_EVENT_TYPES } from 'src/lib/soatEvents';

/**
 * Direct lib tests: the subscription filter has no entry point of its own. A
 * REST route can only prove that *some* subscriber reacted, which is exactly
 * what the filter is not about — it decides which events a subscriber never
 * sees, and the observable difference is a handler that is not called.
 *
 * Every test tears its listener down in `finally`: `eventBus` is a module
 * singleton, so a leaked listener would fire for every later test in the run
 * (`.claude/rules/tests.md`).
 */
describe('eventBus', () => {
  const drain = async () => {
    // `emitCustomEvent` without a `projectPublicId` resolves it through the DB
    // before emitting, so let the microtask queue settle before asserting.
    await new Promise((resolve) => {
      return setImmediate(resolve);
    });
  };

  describe('onEvent', () => {
    test('an unfiltered subscriber receives every event', async () => {
      const seen: string[] = [];
      const handler = (event: { type: string }) => {
        seen.push(event.type);
      };

      onEvent({ handler });

      try {
        eventBus.emit('soat:event', { type: 'files.created' });
        eventBus.emit('soat:event', { type: 'sessions.created' });
        await drain();
        expect(seen).toEqual(['files.created', 'sessions.created']);
      } finally {
        eventBus.removeAllListeners('soat:event');
      }
    });

    test('a filtered subscriber receives only the types it declared', async () => {
      const seen: string[] = [];

      onEvent({
        types: ['files.created', 'files.deleted'],
        handler: (event) => {
          seen.push(event.type);
        },
      });

      try {
        eventBus.emit('soat:event', { type: 'files.created' });
        eventBus.emit('soat:event', { type: 'sessions.created' });
        eventBus.emit('soat:event', { type: 'files.deleted' });
        await drain();
        expect(seen).toEqual(['files.created', 'files.deleted']);
      } finally {
        eventBus.removeAllListeners('soat:event');
      }
    });

    test('a filtered subscriber never sees a custom orchestration event', async () => {
      const seen: string[] = [];

      onEvent({
        types: ['orchestration_runs.succeeded'],
        handler: (event) => {
          seen.push(event.type);
        },
      });

      try {
        eventBus.emit('soat:event', { type: 'order.shipped' });
        eventBus.emit('soat:event', { type: 'orchestration_runs.succeeded' });
        await drain();
        expect(seen).toEqual(['orchestration_runs.succeeded']);
      } finally {
        eventBus.removeAllListeners('soat:event');
      }
    });
  });

  describe('emitCustomEvent', () => {
    test('carries a user-authored name through to unfiltered subscribers', async () => {
      const seen: string[] = [];
      const handler = (event: { type: string }) => {
        seen.push(event.type);
      };

      onEvent({ handler });

      try {
        emitCustomEvent({
          type: 'order.shipped',
          projectId: 1,
          projectPublicId: 'proj_test',
          resourceType: 'orchestration_run',
          resourceId: 'orun_test',
          data: { order_id: 'ord_1' },
        });
        await drain();
        expect(seen).toEqual(['order.shipped']);
      } finally {
        eventBus.removeAllListeners('soat:event');
      }
    });
  });
});

describe('soatEvents registry', () => {
  test('isSoatEventType recognizes a registered event and rejects others', () => {
    expect(isSoatEventType('files.created')).toBe(true);
    expect(isSoatEventType('files.creted')).toBe(false);
    expect(isSoatEventType('order.shipped')).toBe(false);
  });

  test('every registered event name is unique across resource types', () => {
    expect(new Set(SOAT_EVENT_TYPES).size).toBe(SOAT_EVENT_TYPES.length);
  });

  test('every registered event name follows the <resource>.<verb> convention', () => {
    for (const type of SOAT_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });
});
