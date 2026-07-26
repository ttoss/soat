# PRD: Orchestration Queue-Backed Execution

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G2).
> ✅ **Fully shipped.** The live behavior is documented in
> [orchestrations.md → Durable Background Execution](../packages/website/docs/modules/orchestrations.md#durable-background-execution);
> this file is kept only as the record of what the initiative delivered.
> Phase 1 (Postgres queue driver + idempotency keys), Phase 2 (concurrency
> limits + queue-stats endpoint + graceful shutdown + worker-fleet ops), and
> Phase 3 (pluggable driver + SQS) are all done.

## Implementation Status

| Component                                      | Status     | Notes                                                                                                              |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Worker-fleet ops hardening                     | ✅ Shipped | Dedicated compose worker service off the same image, heartbeat-based worker healthcheck, worker-fleet smoke coverage |
| Pluggable driver interface + SQS driver        | ✅ Shipped | `ORCHESTRATION_QUEUE_DRIVER=postgres\|sqs`, shared conformance suite, queue soak harness                              |

## Implementation Phases

### Phase 2 tail — Worker-fleet ops hardening ✅ Shipped

Concurrency limits, the `ORCHESTRATION_WORKER_CONCURRENCY` cross-tick cap, the
`GET /api/v1/orchestrations/queue/stats` endpoint, and graceful worker shutdown
(`SIGTERM`/`SIGINT` handlers in `worker.ts`) shipped earlier. The deploy/ops
tooling deferred from Phase 1 now ships too:

**Delivered:**

- `src/worker.ts` and `src/workerHealthcheck.ts` are build entrypoints, so the
  production image carries `dist/worker.mjs` and `dist/workerHealthcheck.mjs`
  alongside the API — a worker fleet is a second service off the same image.
- A dedicated `worker` compose service in `tests/docker-compose.smoke.yml`,
  with `ORCHESTRATION_WORKER_DISABLED=true` on the API service so the fleet is
  the only thing draining the queue.
- A worker healthcheck: the worker republishes a heartbeat file
  (`ORCHESTRATION_WORKER_HEARTBEAT_FILE`) after every **successful** queue
  claim, and `workerHealthcheck.mjs` grades its freshness against
  `ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS`. Grading the last successful claim,
  not the last timer tick, means a worker that still ticks but can no longer
  reach the queue reports unhealthy.
- Worker-fleet smoke coverage: an async run (`start-orchestration-run` with no
  `--wait`) that only reaches `succeeded` because the standalone worker claimed
  and drove it, followed by a queue-drained-to-empty assertion.

**Acceptance criteria — met:**

- `GET /health` still returns `{"status":"ok"}`, unchanged.
- A standalone worker brought up via compose claims and drains a seeded backlog
  with the API process serving requests only.

### Phase 3 — Pluggable driver interface + SQS driver ✅ Shipped

**Delivered:**

- `ORCHESTRATION_QUEUE_DRIVER=postgres|sqs`, Postgres remaining the default. An
  unknown driver — or `sqs` without `ORCHESTRATION_QUEUE_SQS_QUEUE_URL` —
  fails loudly with `QUEUE_DRIVER_MISCONFIGURED` instead of silently falling
  back.
- A driver abstraction (`enqueue` / `claim` / `ack` / `retry` / `stats`) in
  `src/lib/orchestration-queue-drivers/`; the engine, scheduler, worker, and
  stats endpoint all go through it.
- An SQS driver mapping the abstraction onto SQS semantics: `SendMessage`
  (`DelaySeconds`) → delayed availability, visibility timeout → lease,
  `ApproximateReceiveCount` → `attempts`, `DeleteMessage` → ack,
  `ChangeMessageVisibility` → retry backoff, and the queue's redrive policy →
  DLQ for repeated failures.
- A shared conformance suite both drivers pass
  (`tests/unit/tests/lib/orchestrationQueueDriverConformance.test.ts`), running
  the real SQS driver and AWS client against a local fake SQS server so command
  serialization is exercised for real.
- A load/soak harness (`pnpm --filter @soat/server queue-soak`) that drives a
  sustained backlog through the configured driver and reports throughput, claim
  latency percentiles, and whether the backlog stayed bounded.

**Documented non-uniformity.** Per-project `max_concurrent_runs` is enforced by
the Postgres driver only — its claim is a SQL join over tasks → runs → projects
evaluated in the leasing transaction, which SQS cannot express at receive time.
Under `sqs`, only the per-worker `ORCHESTRATION_WORKER_CONCURRENCY` cap applies,
and the stats endpoint reports `oldest_queued_age_seconds: null` with an empty
`per_project` breakdown. The conformance suite asserts this difference so it
stays visible rather than surprising an operator.
