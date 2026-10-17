import { eventBus, onEvent } from 'src/lib/eventBus';
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
  // A minimal envelope that still holds the payload contract every emitted
  // event is checked against (`eventRecordContract.ts`).
  const envelope = (type: string) => {
    return { type, resourceId: 'res_1', data: { id: 'res_1' } };
  };

  const drain = async () => {
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
        eventBus.emit('soat:event', envelope('files.created'));
        eventBus.emit('soat:event', envelope('sessions.created'));
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
        eventBus.emit('soat:event', envelope('files.created'));
        eventBus.emit('soat:event', envelope('sessions.created'));
        eventBus.emit('soat:event', envelope('files.deleted'));
        await drain();
        expect(seen).toEqual(['files.created', 'files.deleted']);
      } finally {
        eventBus.removeAllListeners('soat:event');
      }
    });

    test('a filtered subscriber never sees a custom orchestration event', async () => {
      const seen: string[] = [];

      onEvent({
        types: ['orchestration_runs.completed'],
        handler: (event) => {
          seen.push(event.type);
        },
      });

      try {
        eventBus.emit('soat:event', envelope('order.shipped'));
        eventBus.emit('soat:event', envelope('orchestration_runs.completed'));
        await drain();
        expect(seen).toEqual(['orchestration_runs.completed']);
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
