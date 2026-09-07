const BATCH_LIMIT = 20;

type Logger = (formatter: string, ...args: unknown[]) => void;

type SweepConfig<M> = {
  log: Logger;
  /** Short label used in log lines and as the in-flight guard's identity. */
  name: string;
  /** Guards against the same row being claimed twice within a single process
   * if a tick fires again before an in-flight claim finishes. */
  inFlight: Set<number>;
  batchLimit?: number;
  /** The batch query for rows that are due. */
  findDue: (args: { now: Date; limit: number }) => Promise<M[]>;
  /** Internal id used for the in-flight guard. */
  idOf: (row: M) => number;
  /** Atomically claims a row (a guarded conditional `UPDATE`), returning
   * whether this call won the claim. Must stay a conditional `UPDATE` — never
   * read-then-write — so overlapping ticks or multiple instances claim each
   * row exactly once. */
  claim: (args: { row: M; now: Date }) => Promise<boolean>;
  /** Background work for a claimed row. Runs detached (`void`-dispatched);
   * the poller logs and swallows a rejection rather than letting it surface. */
  handle: (args: { row: M }) => Promise<void>;
};

export type Sweep = (args?: { now?: Date }) => Promise<number>;

/**
 * Builds one sweep of a poller: find the due batch, atomically claim each row
 * not already in flight, and dispatch its handler in the background. Returns
 * the number of rows claimed this call. A query failure is logged and treated
 * as zero due rows rather than thrown, matching the scheduler's
 * fire-and-forget design.
 */
export const createSweep = <M>(config: SweepConfig<M>): Sweep => {
  const limit = config.batchLimit ?? BATCH_LIMIT;

  return async (args) => {
    const now = args?.now ?? new Date();

    let due: M[];
    try {
      due = await config.findDue({ now, limit });
    } catch (error) {
      config.log('%s: query failed %o', config.name, error);
      return 0;
    }

    let claimedCount = 0;
    for (const row of due) {
      const id = config.idOf(row);
      if (config.inFlight.has(id)) continue;

      const claimed = await config.claim({ row, now });
      if (!claimed) continue;

      config.inFlight.add(id);
      claimedCount += 1;
      void config
        .handle({ row })
        .catch((error: unknown) => {
          config.log('%s: handle failed id=%s %o', config.name, id, error);
        })
        .finally(() => {
          config.inFlight.delete(id);
        });
    }

    return claimedCount;
  };
};

type SchedulerConfig = {
  log: Logger;
  defaultIntervalMs: number;
  /** Env var read for the interval override, e.g. `ORCHESTRATION_SCHEDULER_INTERVAL_MS`. */
  envVar?: string;
  /** Env var that, when `'true'`, keeps `start` from ever creating a timer. */
  disabledEnvVar?: string;
  /** Sweeps run in order on every tick. */
  sweeps: Sweep[];
};

/**
 * Owns the timer/interval scaffolding shared by every background poller: an
 * idempotent `start` that resolves the interval (explicit override → env var
 * → default), sweeps once immediately and then on each tick, and a `stop` for
 * graceful shutdown / test teardown. The timer is unref'd so it never keeps
 * the process alive on its own.
 */
export const createScheduler = (
  config: SchedulerConfig
): { start: (args?: { intervalMs?: number }) => void; stop: () => void } => {
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Sweeps are dispatched fire-and-forget, so a rejecting one would surface as
   * an unhandled promise and take the process down under a strict handler.
   * Most sweeps already swallow their own failures; catching here covers the
   * ones that can reject before their first `try` (a `findAll` of the batch,
   * say) and keeps one sweep's failure from skipping the rest.
   */
  const runSweeps = (): void => {
    for (const sweep of config.sweeps) {
      void sweep().catch((error: unknown) => {
        config.log('sweep failed %o', error);
      });
    }
  };

  const start = (args?: { intervalMs?: number }): void => {
    if (timer) return;
    if (
      config.disabledEnvVar &&
      process.env[config.disabledEnvVar] === 'true'
    ) {
      config.log('start: disabled via %s', config.disabledEnvVar);
      return;
    }

    const envIntervalMs = config.envVar
      ? Number(process.env[config.envVar])
      : Number.NaN;
    const intervalMs = args?.intervalMs ?? envIntervalMs;
    const resolvedInterval =
      Number.isFinite(intervalMs) && intervalMs > 0
        ? intervalMs
        : config.defaultIntervalMs;

    config.log('start: interval=%dms', resolvedInterval);
    timer = setInterval(runSweeps, resolvedInterval);
    timer.unref?.();

    // The first tick lands one whole interval after boot, and a restart begins
    // the interval again from zero — so a sweep on a daily interval only ever
    // runs if the process survives 24 unbroken hours, which a service that
    // redeploys or recycles daily never does (#1229). Assigned to `timer`
    // first, so this stays idempotent against a re-entrant `start`.
    runSweeps();
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop };
};
