import {
  cancelDelayTimer,
  scheduleDelayedGeneration,
} from 'src/lib/sessionDelayHelpers';

describe('sessionDelayHelpers', () => {
  describe('scheduleDelayedGeneration', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('unrefs the debounce timer so it cannot keep the process alive', () => {
      // The delayed-generation debounce timer is a background side effect. Like
      // the pollers in scheduler.ts (which call `timer.unref()`), it must not
      // hold the Node event loop open — otherwise a session scheduled near the
      // end of a test run leaves an active timer and Jest reports "a worker
      // process has failed to exit gracefully ... ensure that .unref() was
      // called on them".
      const realSetTimeout = global.setTimeout;
      const armed: ReturnType<typeof setTimeout>[] = [];

      jest
        .spyOn(global, 'setTimeout')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation((callback: (...a: any[]) => void, ms, ...args) => {
          const timer = realSetTimeout(callback, ms, ...args);
          armed.push(timer);
          return timer;
        });

      const sessionKey = 'agent-1#sess_delay_unref';

      try {
        scheduleDelayedGeneration({
          sessionKey,
          agentId: 1,
          sessionId: 'sess_delay_unref',
          // Long enough that it never fires during the test.
          delayMs: 60_000,
          generateFn: () => {
            return Promise.resolve();
          },
        });

        expect(armed).toHaveLength(1);
        // `hasRef()` is false only when `unref()` has been called on the timer.
        expect(armed[0].hasRef()).toBe(false);
      } finally {
        cancelDelayTimer(sessionKey);
      }
    });
  });
});
