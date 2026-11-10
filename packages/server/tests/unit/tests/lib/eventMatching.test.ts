import type { SoatEvent } from 'src/lib/eventBus';
import {
  type EventFilter,
  matchesEventFilter,
  validateEventFilter,
} from 'src/lib/eventMatching';

/**
 * The event filter event triggers and webhooks share, as a pure function: the
 * dispatchers' wiring, and the read guard, are tested through the event flow
 * in `rest/triggerEventDispatch.test.ts` and `rest/webhookDelivery.test.ts`.
 */
const event: SoatEvent = {
  id: '00000000-0000-4000-8000-000000000000',
  type: 'files.created',
  projectId: 1,
  projectPublicId: 'prj_a',
  resourceType: 'file',
  resourceId: 'file_1',
  data: { filename: 'cycle.txt', size: 3 },
  timestamp: '2026-11-10T00:00:00.000Z',
};

const filter = (overrides: Partial<EventFilter>): EventFilter => {
  return { events: ['*'], eventResources: null, eventData: null, ...overrides };
};

describe('matchesEventFilter', () => {
  test.each<[string, Partial<EventFilter>, boolean]>([
    ['an exact type', { events: ['files.created'] }, true],
    ['a prefix', { events: ['files.*'] }, true],
    ['another type', { events: ['files.deleted'] }, false],
    ['no patterns', { events: null }, false],
    ['a resource pattern', { eventResources: ['srn:prj_a:file:*'] }, true],
    ['another resource', { eventResources: ['srn:prj_a:document:*'] }, false],
    ['no resource pattern', { eventResources: [] }, false],
    ['an equal field', { eventData: { filename: 'cycle.txt' } }, true],
    ['an unequal field', { eventData: { filename: 'other.txt' } }, false],
    ['an absent field', { eventData: { owner: 'x' } }, false],
    ['in', { eventData: { filename: { in: ['cycle.txt', 'x'] } } }, true],
    ['a numeric range', { eventData: { size: { gt: 1, lte: 3 } } }, true],
    ['a range on another type', { eventData: { filename: { lt: 5 } } }, false],
    [
      'a string range',
      { eventData: { filename: { gte: 'cycle', lt: 'z' } } },
      true,
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(matchesEventFilter({ filter: filter(overrides), event })).toBe(
      expected
    );
  });
});

describe('validateEventFilter', () => {
  test('accepts a full filter and fields not sent', () => {
    expect(() => {
      validateEventFilter({
        events: ['files.*', 'orders.shipped'],
        eventResources: ['*', 'srn:prj_a:file:*'],
        eventData: { size: { gte: 1 } },
      });
    }).not.toThrow();
    expect(() => {
      validateEventFilter({});
    }).not.toThrow();
  });

  test.each<[string, Parameters<typeof validateEventFilter>[0], string]>([
    ['an empty events list', { events: [] }, 'VALIDATION_FAILED'],
    [
      'a misspelt platform event',
      { events: ['files.creatd'] },
      'INVALID_EVENT_PATTERN',
    ],
    [
      'a malformed pattern',
      { events: ['files.*.x*'] },
      'INVALID_EVENT_PATTERN',
    ],
    [
      'a resource that is not an SRN',
      { eventResources: ['file:*'] },
      'VALIDATION_FAILED',
    ],
    [
      'an unordered range operand',
      { eventData: { size: { gt: true } } },
      'VALIDATION_FAILED',
    ],
  ])('refuses %s', (_label, args, code) => {
    expect(() => {
      validateEventFilter(args);
    }).toThrow(expect.objectContaining({ code }));
  });
});
