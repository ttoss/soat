import { Client } from 'pg';
import { db } from 'src/db';
import {
  closeGenerationWakeup,
  subscribeGenerationProgress,
} from 'src/lib/generationWakeup';

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
}): Promise<boolean> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await notify(args.generationDbId);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    if (args.wake.mock.calls.length > 0) return true;
  }
  return false;
};

/** Waits on a bounded predicate over a side effect. */
const until = async (done: () => boolean): Promise<boolean> => {
  for (let attempt = 0; attempt < 80 && !done(); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return done();
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

    expect(await wokenBy({ generationDbId: 101, wake })).toBe(true);
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
    expect(await wokenBy({ generationDbId: 201, wake: first })).toBe(true);
    const end = failNextEnd();

    captured.client()?.emit('error', new Error('connection lost'));

    expect(
      await until(() => {
        return end.mock.calls.length === 1;
      })
    ).toBe(true);
    expect(captured.client()?.listenerCount('notification')).toBe(0);

    const second = jest.fn();
    const unsubscribeSecond = subscribeGenerationProgress({
      generationDbId: 202,
      wake: second,
    });
    expect(await wokenBy({ generationDbId: 202, wake: second })).toBe(true);
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

    expect(
      await until(() => {
        return end.mock.calls.length === 1;
      })
    ).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);

    const retry = jest.fn();
    const unsubscribeRetry = subscribeGenerationProgress({
      generationDbId: 302,
      wake: retry,
    });
    expect(await wokenBy({ generationDbId: 302, wake: retry })).toBe(true);
    unsubscribe();
    unsubscribeRetry();
  });

  test('close tolerates a failing end', async () => {
    const wake = jest.fn();
    const unsubscribe = subscribeGenerationProgress({
      generationDbId: 401,
      wake,
    });
    expect(await wokenBy({ generationDbId: 401, wake })).toBe(true);
    unsubscribe();
    const end = failNextEnd();

    await expect(closeGenerationWakeup()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
