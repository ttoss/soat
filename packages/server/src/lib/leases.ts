import { randomUUID } from 'node:crypto';

/**
 * A duration read from `name`, in milliseconds; `fallbackMs` when it is unset
 * or not a positive number.
 */
export const durationFromEnv = (args: {
  name: string;
  fallbackMs: number;
}): number => {
  const configured = Number(process.env[args.name]);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : args.fallbackMs;
};

/** When a lease taken at `now` lapses. */
export const leaseExpiry = (args: { ttlMs: number; now?: number }): Date => {
  return new Date((args.now ?? Date.now()) + args.ttlMs);
};

/** The token a conditional write fences a holder by. */
export const newLeaseToken = (): string => {
  return randomUUID();
};

/**
 * Calls `renew` every `intervalMs` until the returned `release` is called. A
 * renewal answering `false` means the lease is gone: `onLost` runs once and the
 * heartbeat stops. A rejecting renewal is passed to `onError` and the next beat
 * tries again.
 */
export const holdLease = (args: {
  intervalMs: number;
  renew: () => Promise<boolean | void>;
  onLost?: () => void;
  onError?: (error: unknown) => void;
}): { release: () => void } => {
  const timer = setInterval(() => {
    void args
      .renew()
      .then((held) => {
        if (held !== false) return;
        clearInterval(timer);
        args.onLost?.();
      })
      .catch((error: unknown) => {
        args.onError?.(error);
      });
  }, args.intervalMs);
  // A heartbeat never keeps the process alive on its own.
  timer.unref?.();
  return {
    release: () => {
      clearInterval(timer);
    },
  };
};
