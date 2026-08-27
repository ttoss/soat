export type RunTaskKind = 'continue' | 'wake' | 'resume';

/** The queue backends a deployment can select with `ORCHESTRATION_QUEUE_DRIVER`. */
export type QueueDriverName = 'postgres' | 'sqs';

/**
 * A task handed to a worker by a driver's `claim`, in a driver-neutral shape.
 *
 * `id` is a human-readable identity for logs and traces (the task's public id
 * on Postgres, the message id on SQS). `handle` is the **opaque** token the
 * driver needs to `ack` or `retry` that specific delivery — a row id on
 * Postgres, a receipt handle on SQS. Callers must treat `handle` as opaque and
 * pass the whole task back rather than reconstructing it.
 */
export type ClaimedTask = {
  id: string;
  handle: string;
  orchestrationRunId: number;
  kind: RunTaskKind;
  /** Delivery count for this task, including the current delivery. */
  attempts: number;
};

/** A point-in-time snapshot of the run queue, as reported by the active driver. */
export type QueueStats = {
  driver: QueueDriverName;
  queueDepth: number;
  claimedTasks: number;
  oldestQueuedAgeSeconds: number | null;
  claimLatencyMs: {
    p50: number | null;
    p95: number | null;
    windowSeconds: number;
  };
  perProject: Array<{ projectId: string; queued: number; claimed: number }>;
};

/**
 * The orchestration queue abstraction: the four operations the durable runtime
 * needs, plus a stats snapshot for the operator endpoint.
 *
 * Both drivers are interchangeable for the runtime's purposes and held to it by
 * `lib/orchestrationQueueDriverConformance.test.ts`: at-least-once delivery
 * (a claimed task holds an `ORCHESTRATION_TASK_LEASE_TTL_MS` lease and is
 * redelivered if not acked, `attempts` counting deliveries), delayed
 * availability, and exclusive claim.
 *
 * `enforcesProjectConcurrency` is the one thing not uniform: only the Postgres
 * driver can evaluate a project's `max_concurrent_runs` at claim time; on SQS
 * only the per-worker `ORCHESTRATION_WORKER_CONCURRENCY` cap applies.
 */
export type OrchestrationQueueDriver = {
  readonly name: QueueDriverName;
  /** Whether `claim` honours each project's `max_concurrent_runs` (D8/D9). */
  readonly enforcesProjectConcurrency: boolean;
  /** Makes a task for `orchestrationRunId` claimable, at `availableAt` or immediately. */
  enqueue: (args: {
    orchestrationRunId: number;
    kind: RunTaskKind;
    availableAt?: Date;
  }) => Promise<void>;
  /** Claims up to `limit` due tasks, leasing each to this caller. */
  claim: (args: { limit: number; now?: Date }) => Promise<ClaimedTask[]>;
  /** Acknowledges a delivered task as done; it is never delivered again. */
  ack: (args: { task: ClaimedTask }) => Promise<void>;
  /** Releases a delivered task back to the queue, claimable at `availableAt`. */
  retry: (args: { task: ClaimedTask; availableAt: Date }) => Promise<void>;
  /** A snapshot of the queue for the operator stats endpoint. */
  stats: (args?: { projectIds?: number[]; now?: Date }) => Promise<QueueStats>;
};
