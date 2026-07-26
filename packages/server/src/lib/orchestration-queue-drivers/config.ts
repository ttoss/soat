const DEFAULT_TASK_LEASE_TTL_MS = 60_000; // 1 minute

/**
 * How long a claimed task's lease is valid before it may be redelivered — the
 * lease TTL every driver honours (`lease_expires_at` on Postgres, the message's
 * visibility timeout on SQS). It only needs to exceed the time driving a run to
 * its next resting point takes; a worker that finishes acks the task well
 * before then. Configurable via `ORCHESTRATION_TASK_LEASE_TTL_MS`.
 */
export const taskLeaseTtlMs = (): number => {
  const configured = Number(process.env.ORCHESTRATION_TASK_LEASE_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TASK_LEASE_TTL_MS;
};
