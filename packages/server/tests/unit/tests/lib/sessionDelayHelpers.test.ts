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
      // The debounce timer must not hold the event loop open, or a session
      // scheduled near the end of a run leaves Jest reporting a worker that
      // failed to exit gracefully.
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
