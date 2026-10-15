/**
 * How long a claimed execution is trusted to be running. No heartbeat extends
 * it, as with a decision: one still running past it is recovered as
 * interrupted, and its late answer finds it settled.
 */
export const EXECUTION_LEASE_MS = 15 * 60 * 1000;

/** How often a task or run an execution waits on is read again. */
export const PARKED_RECHECK_MS = 5 * 60 * 1000;
