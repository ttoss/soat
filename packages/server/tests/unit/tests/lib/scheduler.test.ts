import { createScheduler, type Sweep } from 'src/lib/scheduler';

/**
 * The timer scaffolding every background poller shares. Driven directly with
 * stub sweeps: what is under test is when the scheduler calls them, not what
 * any particular sweep does.
 */
describe('createScheduler', () => {
  const log = jest.fn();

  // Fake timers keep the interval under the test's control: no real waiting and
  // no leaked timer.
  beforeEach(() => {
    jest.useFakeTimers();
    log.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const okSweep = (): jest.Mock<ReturnType<Sweep>> => {
    return jest.fn(async () => {
      return 0;
    });
  };

  test('sweeps once at start, before the first interval elapses', () => {
    const first = okSweep();
    const second = okSweep();
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 24 * 60 * 60 * 1000,
      sweeps: [first, second],
    });

    scheduler.start();

    // A daily interval only reaches its first tick after 24 unbroken hours, so
    // a service that restarts more often than that never sweeps at all
    // (#1229). Every sweep runs at start for that reason.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  test('keeps ticking on the interval after the sweep at start', async () => {
    const sweep = okSweep();
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      sweeps: [sweep],
    });

    scheduler.start();
    expect(sweep).toHaveBeenCalledTimes(1);

    // The interval is unchanged by the startup sweep: it still measures from
    // start, rather than the startup run standing in for the first tick.
    await jest.advanceTimersByTimeAsync(4999);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  test('a second start neither sweeps again nor adds a timer', async () => {
    const sweep = okSweep();
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      sweeps: [sweep],
    });

    scheduler.start();
    scheduler.start();
    expect(sweep).toHaveBeenCalledTimes(1);

    // One timer, so one sweep per interval rather than two.
    await jest.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  test('falls back to the default interval for an invalid override', async () => {
    const sweep = okSweep();
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      sweeps: [sweep],
    });

    scheduler.start({ intervalMs: 0 });
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(4999);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  test('reads the interval from the env var when no override is given', async () => {
    const sweep = okSweep();
    process.env.SWEEP_INTERVAL_MS_TEST = '2000';
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      envVar: 'SWEEP_INTERVAL_MS_TEST',
      sweeps: [sweep],
    });

    scheduler.start();

    await jest.advanceTimersByTimeAsync(2000);
    expect(sweep).toHaveBeenCalledTimes(2);

    scheduler.stop();
    delete process.env.SWEEP_INTERVAL_MS_TEST;
  });

  test('prefers an explicit override over the env var', async () => {
    const sweep = okSweep();
    process.env.SWEEP_INTERVAL_MS_TEST = '2000';
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      envVar: 'SWEEP_INTERVAL_MS_TEST',
      sweeps: [sweep],
    });

    scheduler.start({ intervalMs: 3000 });

    await jest.advanceTimersByTimeAsync(2999);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);

    scheduler.stop();
    delete process.env.SWEEP_INTERVAL_MS_TEST;
  });

  test('does not sweep at start when disabled', () => {
    const sweep = okSweep();
    process.env.SWEEP_DISABLED_TEST = 'true';
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      disabledEnvVar: 'SWEEP_DISABLED_TEST',
      sweeps: [sweep],
    });

    scheduler.start();

    expect(sweep).not.toHaveBeenCalled();
    delete process.env.SWEEP_DISABLED_TEST;
  });

  test('logs a rejecting sweep and runs the ones after it', async () => {
    const failure = new Error('db unreachable');
    const rejecting: jest.Mock<ReturnType<Sweep>> = jest.fn(async () => {
      throw failure;
    });
    const after = okSweep();
    const scheduler = createScheduler({
      log,
      defaultIntervalMs: 5000,
      sweeps: [rejecting, after],
    });

    scheduler.start();

    // Sweeps are dispatched fire-and-forget, so an uncaught rejection would
    // surface as an unhandled promise rather than as a failing sweep — and the
    // startup run is the likeliest place to meet one, being the closest to boot.
    await Promise.resolve();
    expect(after).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('sweep failed %o', failure);

    scheduler.stop();
  });
});
