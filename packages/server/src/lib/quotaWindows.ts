// Fixed-window math shared by every quota enforcement point (the request
// middleware, the token/cost pre-generation check, and the CRUD current-usage
// read). Rolling windows are implemented as fixed windows keyed by a truncated
// timestamp; `calendar_month` keys are `YYYY-MM`, matching metering's
// convention. Kept dependency-free so it stays trivially unit-testable.

export const QUOTA_WINDOWS = [
  'rolling_1m',
  'rolling_1h',
  'rolling_24h',
  'calendar_month',
] as const;

export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

/**
 * The fixed-window key a timestamp falls into for a given window
 * (`2026-07-07T12:31Z` for `rolling_1m`; `2026-07` for `calendar_month`).
 */
export const windowKeyFor = (args: {
  window: QuotaWindow;
  now: Date;
}): string => {
  const iso = args.now.toISOString(); // e.g. 2026-07-07T12:31:45.123Z
  switch (args.window) {
    case 'rolling_1h':
      return `${iso.slice(0, 13)}Z`; // 2026-07-07T12Z
    case 'rolling_24h':
      return `${iso.slice(0, 10)}Z`; // 2026-07-07Z
    case 'calendar_month':
      return iso.slice(0, 7); // 2026-07
    case 'rolling_1m':
    default:
      return `${iso.slice(0, 16)}Z`; // 2026-07-07T12:31Z
  }
};

/**
 * The instant the current window rolls over — the start of the next fixed
 * window. Used for the `resets_at` field and the `Retry-After` header.
 */
export const windowResetsAt = (args: {
  window: QuotaWindow;
  now: Date;
}): Date => {
  const d = new Date(args.now.getTime());
  switch (args.window) {
    case 'rolling_1h':
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() + 1);
      return d;
    case 'rolling_24h':
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    case 'calendar_month':
      return new Date(
        Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth() + 1, 1)
      );
    case 'rolling_1m':
    default:
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(d.getUTCMinutes() + 1);
      return d;
  }
};

/**
 * The instant the current window began — the start of the fixed window a
 * timestamp falls into. The token/cost pre-generation check aggregates
 * `UsageEvent` rows created at or after this instant. Symmetric with
 * `windowResetsAt` (which returns the end of the same window).
 */
export const windowStartsAt = (args: {
  window: QuotaWindow;
  now: Date;
}): Date => {
  const d = new Date(args.now.getTime());
  switch (args.window) {
    case 'rolling_1h':
      d.setUTCMinutes(0, 0, 0);
      return d;
    case 'rolling_24h':
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case 'calendar_month':
      return new Date(
        Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth(), 1)
      );
    case 'rolling_1m':
    default:
      d.setUTCSeconds(0, 0);
      return d;
  }
};

/** Seconds from `now` until `resetsAt`, floored at 0, rounded up. */
export const retryAfterSeconds = (args: {
  resetsAt: Date;
  now: Date;
}): number => {
  return Math.max(
    0,
    Math.ceil((args.resetsAt.getTime() - args.now.getTime()) / 1000)
  );
};
