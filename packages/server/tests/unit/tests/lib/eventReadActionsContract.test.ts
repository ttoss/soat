import { EVENT_READ_ACTIONS } from 'src/lib/eventReadActions';
import { listAllActions } from 'src/lib/permissionCatalog';
import { SOAT_EVENTS } from 'src/lib/soatEvents';

/**
 * An event trigger receives an event only when its policies allow the read
 * action of the event's resource, so each one must be an action a policy
 * author can write.
 */
describe('EVENT_READ_ACTIONS', () => {
  test('names a read action for every resource type the bus carries', () => {
    expect(Object.keys(EVENT_READ_ACTIONS).sort()).toEqual(
      Object.keys(SOAT_EVENTS).sort()
    );
  });

  test('every read action is in the permission catalog', () => {
    const catalog = listAllActions();

    expect(
      Object.values(EVENT_READ_ACTIONS).filter((action) => {
        return !catalog.has(action);
      })
    ).toEqual([]);
  });
});
