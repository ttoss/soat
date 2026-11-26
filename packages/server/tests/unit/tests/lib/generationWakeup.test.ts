import { Client } from 'pg';
import { db } from 'src/db';
import {
  closeGenerationWakeup,
  subscribeGenerationProgress,
} from 'src/lib/generationWakeup';

import { pollUntil } from '../../fixtures/poll';

const CHANNEL = 'soat_generation_progress';

const notify = async (generationDbId: number) => {
  await db.sequelize.query('SELECT pg_notify(:channel, :payload)', {
    replacements: { channel: CHANNEL, payload: String(generationDbId) },
  });
};

/** Notifies until `wake` runs: the listener connects asynchronously. */
const wokenBy = async (args: {
  generationDbId: number;
  wake: jest.Mock;
}): Promise<void> => {
  await pollUntil({
    read: async () => {
      await notify(args.generationDbId);
      return args.wake.mock.calls.length;
    },
    done: (calls) => {
      return calls > 0;
    },
  });
};

/** Waits on a bounded predicate over a side effect. */
const until = async (done: () => boolean): Promise<void> => {
  await pollUntil({
    read: done,
    done: (holds) => {
      return holds;
    },
  });
};

/** The listener's client, captured as it connects. */
const captureClient = () => {
  const connect = jest.spyOn(Client.prototype, 'connect');
  return {
    client: (): Client | undefined => {
      return connect.mock.contexts[0];
    },
  };
};

/** The next `end` closes the connection, then rejects. */
const failNextEnd = () => {
  const end: (this: Client) => Promise<void> = Client.prototype.end;
  return jest
    .spyOn(Client.prototype, 'end')
    .mockImplementationOnce(async function (this: Client) {
      await end.call(this);
      throw new Error('end failed');
    });
};

describe('generationWakeup', () => {
  afterEach(async () => {
    await closeGenerationWakeup();
    jest.restoreAllMocks();
  });

  test('a notification wakes the subscriber of that generation only', async () => {
    const wake = jest.fn();
    const other = jest.fn();
    const unsubscribe = subscribeGenerationProgress({
      generationDbId: 101,
      wake,
    });
    const unsubscribeOther = subscribeGenerationProgress({
      generationDbId: 102,
      wake: other,
    });

    await wokenBy({ generationDbId: 101, wake });
    expect(other).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribeOther();
  });

  test('a listener error drops the connection, tolerating a failing end, and the next subscriber listens again', async () => {
    const captured = captureClient();
    const first = jest.fn();
    const unsubscribeFirst = subscribeGenerationProgress({
      generationDbId: 201,
      wake: first,
    });
    await wokenBy({ generationDbId: 201, wake: first });
    const end = failNextEnd();

    captured.client()?.emit('error', new Error('connection lost'));

    await until(() => {
      return end.mock.calls.length === 1;
    });
    expect(captured.client()?.listenerCount('notification')).toBe(0);

    const second = jest.fn();
    const unsubscribeSecond = subscribeGenerationProgress({
      generationDbId: 202,
      wake: second,
    });
    await wokenBy({ generationDbId: 202, wake: second });
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test('a listener that cannot connect leaves the subscriber polling, and a later subscriber retries', async () => {
    const connect = jest
      .spyOn(Client.prototype, 'connect')
      .mockImplementationOnce(() => {
        return Promise.reject(new Error('refused'));
      });
    const end = jest.spyOn(Client.prototype, 'end');
    const wake = jest.fn();
    const unsubscribe = subscribeGenerationProgress({
      generationDbId: 301,
      wake,
    });

    await until(() => {
      return end.mock.calls.length === 1;
    });
    expect(connect).toHaveBeenCalledTimes(1);

    const retry = jest.fn();
    const unsubscribeRetry = subscribeGenerationProgress({
      generationDbId: 302,
      wake: retry,
    });
    await wokenBy({ generationDbId: 302, wake: retry });
    unsubscribe();
    unsubscribeRetry();
  });

  test('close tolerates a failing end', async () => {
    const wake = jest.fn();
    const unsubscribe = subscribeGenerationProgress({
      generationDbId: 401,
      wake,
    });
    await wokenBy({ generationDbId: 401, wake });
    unsubscribe();
    const end = failNextEnd();

    await expect(closeGenerationWakeup()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
