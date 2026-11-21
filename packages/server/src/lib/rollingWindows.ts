/**
 * The rolling windows the platform counts production over, each ending at the
 * moment of the read. One list: a guardrail's `runtime.*` keys and an eval's
 * `evidence.live` name a window from it, so the same token means the same
 * span wherever it is written.
 */
export const ROLLING_WINDOWS = ['1h', '24h', '7d', '30d'] as const;

export type RollingWindow = (typeof ROLLING_WINDOWS)[number];

const HOUR_MS = 60 * 60 * 1000;

const ROLLING_WINDOW_MS: Record<RollingWindow, number> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

export const isRollingWindow = (value: unknown): value is RollingWindow => {
  return ROLLING_WINDOWS.some((window) => {
    return window === value;
  });
};

/** The instant a window ending at `now` starts. */
export const rollingWindowStart = (args: {
  window: RollingWindow;
  now: Date;
}): Date => {
  return new Date(args.now.getTime() - ROLLING_WINDOW_MS[args.window]);
};
