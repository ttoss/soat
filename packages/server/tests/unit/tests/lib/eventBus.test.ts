import { db } from 'src/db';
import type * as eventBusModule from 'src/lib/eventBus';
import {
  emitEvent,
  emitResourceEvent,
  eventBus,
  onEvent,
  resolveProjectPublicId,
} from 'src/lib/eventBus';

describe('resolveProjectPublicId', () => {
  test('returns empty string when project does not exist', async () => {
    const result = await resolveProjectPublicId({ projectId: 999999999 });
    expect(result).toBe('');
  });
});

describe('emitEvent / onEvent', () => {
  test('emitted events are received by registered listener', () => {
    const handler = jest.fn();
    onEvent(handler);

    try {
      emitEvent({
        type: 'test.created',
        projectId: 1,
        projectPublicId: 'proj_test',
        resourceType: 'test',
        resourceId: 'res_1',
        data: { key: 'value' },
        timestamp: new Date().toISOString(),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'test.created',
          projectPublicId: 'proj_test',
        })
      );
    } finally {
      eventBus.off('soat:event', handler);
    }
  });
});

describe('emitResourceEvent', () => {
  // The lookup path settles after a real DB round trip, so the emission is
  // awaited by polling the observable side effect — bounded, and with no
  // real-time sleep (tests.md). `settled` drains the same number of ticks for
  // the "nothing was emitted" cases, so those assert on a quiet queue rather
  // than on a race.
  const drainTicks = async (ticks: number): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) {
      await new Promise<void>((resolve) => {
        return void setImmediate(resolve);
      });
    }
  };

  const collect = async (
    emit: () => void,
    expected: number
  ): Promise<eventBusModule.SoatEvent[]> => {
    const received: eventBusModule.SoatEvent[] = [];
    const handler = (event: eventBusModule.SoatEvent) => {
      received.push(event);
    };
    onEvent(handler);
    try {
      emit();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (received.length >= expected) break;
        await drainTicks(1);
      }
      await drainTicks(5);
      return received;
    } finally {
      eventBus.off('soat:event', handler);
    }
  };

  test('stamps the timestamp and passes the caller-supplied public id straight through', async () => {
    const received = await collect(() => {
      emitResourceEvent({
        type: 'tests.created',
        projectId: 1,
        projectPublicId: 'proj_known',
        resourceType: 'test',
        resourceId: 'res_known',
        data: { id: 'res_known' },
      });
    }, 1);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'tests.created',
      projectPublicId: 'proj_known',
      resourceId: 'res_known',
    });
    expect(Date.parse(received[0].timestamp)).not.toBeNaN();
  });

  test('resolves the project public id when the caller does not hold one', async () => {
    const project = await db.Project.create({ name: 'Event Bus Emit Project' });

    const received = await collect(() => {
      emitResourceEvent({
        type: 'tests.updated',
        projectId: project.id as number,
        resourceType: 'test',
        resourceId: 'res_resolved',
        data: { id: 'res_resolved' },
      });
    }, 1);

    expect(received).toHaveLength(1);
    expect(received[0].projectPublicId).toBe(project.publicId);
  });

  // #903: the seventeen hand-rolled resolve-then-emit chains had no `.catch()`,
  // so a rejected project lookup became an unhandled rejection — which
  // terminates the process by default, long after the write it belonged to
  // committed. Forcing the DB read to reject is the only way to reach the
  // swallow branch; per tests.md this is the sanctioned force-failure stub for a
  // `.catch()` resilience branch.
  test('a failed project lookup drops the event instead of rejecting', async () => {
    const findByPk = jest
      .spyOn(db.Project, 'findByPk')
      .mockRejectedValueOnce(new Error('connection terminated'));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const received = await collect(() => {
        emitResourceEvent({
          type: 'tests.deleted',
          projectId: 999999999,
          resourceType: 'test',
          resourceId: 'res_dropped',
          data: { id: 'res_dropped' },
        });
      }, 0);

      expect(received).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      findByPk.mockRestore();
    }
  });
});
