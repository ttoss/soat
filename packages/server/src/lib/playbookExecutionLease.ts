import { leaseExpiry } from './leases';

/**
 * How long a claimed execution is trusted to be running. No heartbeat extends
 * it, as with a decision: one still running past it is recovered as
 * interrupted, and its late answer finds it settled.
 */
export const EXECUTION_LEASE_MS = 15 * 60 * 1000;

/** When an execution claimed at `now` stops being trusted to run. */
export const executionLeaseExpiry = (args?: { now?: number }): Date => {
  return leaseExpiry({ ttlMs: EXECUTION_LEASE_MS, now: args?.now });
};

/** How often a task or run an execution waits on is read again. */
export const PARKED_RECHECK_MS = 5 * 60 * 1000;
