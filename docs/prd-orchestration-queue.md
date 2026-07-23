# PRD: Orchestration Queue-Backed Execution

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G2).
> This PRD covers the **remaining** durability work. The core durable runtime
> already shipped — see
> [orchestrations.md → Durable Background Execution](../packages/website/docs/modules/orchestrations.md#durable-background-execution).
> Phase 1 (Postgres queue driver + idempotency keys) and Phase 2 (concurrency
> limits + queue-stats endpoint + graceful shutdown) have shipped; what remains
> is the Phase 2 worker-fleet ops tail and Phase 3 (pluggable driver + SQS).

## Implementation Status

| Component                                      | Status         | Notes                                                                                       |
| ---------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Worker-fleet ops hardening                     | 🚧 Partial     | Phase 2 tail — graceful shutdown shipped; dedicated compose worker service, worker healthcheck, and fleet smoke coverage remain |
| Pluggable driver interface + SQS driver        | ❌ Not started | Phase 3 — for deployments that standardize on a managed queue                                  |

## Implementation Phases

### Phase 2 tail — Worker-fleet ops hardening 🚧 Partial

Concurrency limits, the `ORCHESTRATION_WORKER_CONCURRENCY` cross-tick cap, the
`GET /api/v1/orchestrations/queue/stats` endpoint, and graceful worker shutdown
(`SIGTERM`/`SIGINT` handlers in `worker.ts`) all shipped. Single-process and
`node dist/worker.js` deployments both run the limits and stats today. The
deploy/ops tooling deferred from Phase 1 remains:

**Remaining deliverables:**

- A dedicated compose worker service (standalone worker fleet), separate from
  the API process.
- A worker healthcheck for that service.
- Worker-fleet smoke coverage exercising a standalone worker draining the queue.

**Acceptance criteria:**

- `GET /health` continues to return `{"status":"ok"}` unchanged (compose
  healthchecks unaffected).
- A standalone worker service brought up via compose claims and drains a seeded
  backlog with the API process serving requests only.

### Phase 3 — Pluggable driver interface + SQS driver ❌ Not started

**Goal:** For deployments that standardize on a managed queue, the queue driver
becomes pluggable and an SQS driver is available alongside the Postgres default.

**Deliverables:**

- Env-selected driver: `ORCHESTRATION_QUEUE_DRIVER=postgres|sqs` (Postgres
  remains the default).
- An SQS driver mapping the queue abstraction (`enqueue`/`claim`/`ack`/`retry`)
  onto SQS semantics: visibility-timeout → lease, DLQ → `failed`.
- A shared driver-conformance suite both drivers must pass, so the two are
  behaviorally interchangeable.
- A load/soak test validating throughput and stability under sustained backlog.
