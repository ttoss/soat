import createDebug from 'debug';

const log = createDebug('soat:orchestrations');

const DEFAULT_LEASE_TTL_MS = 600_000; // 10 minutes

/**
 * How long a run lease is valid before the reaper may reclaim the run. A
 * `running` run refreshes its lease each round while it makes progress, so the
 * TTL only needs to exceed the time a single round (one batch of node
 * executions) can take. Configurable via `ORCHESTRATION_RUN_LEASE_TTL_MS`.
 */
export const leaseTtlMs = (): number => {
  const configured = Number(process.env.ORCHESTRATION_RUN_LEASE_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LEASE_TTL_MS;
};

/**
 * The lease expiry for a run that is (re)entering `running`: `now + TTL`. Pass
 * `now` in tests to make the expiry deterministic.
 */
export const newLeaseExpiry = (args?: { now?: number }): Date => {
  const now = args?.now ?? Date.now();
  const expiry = new Date(now + leaseTtlMs());
  log('newLeaseExpiry: expiry=%s', expiry.toISOString());
  return expiry;
};
