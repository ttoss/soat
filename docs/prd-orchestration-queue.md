# PRD: Orchestration Queue-Backed Execution

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G2).
> This PRD covers the **remaining** durability work. The core durable runtime
> already shipped — see
> [orchestrations.md → Durable Background Execution](../packages/website/docs/modules/orchestrations.md#durable-background-execution).

## Implementation Status

| Component                                      | Status         | Notes                                                                                       |
| ---------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Durable background execution                   | ✅ Implemented | Runs detach from the HTTP request; `start-orchestration-run` returns immediately             |
| Checkpoint-based crash recovery                | ✅ Implemented | Lease (`lease_expires_at`) + reaper; re-drive resumes from the last completed round           |
| No-worker parking (`sleeping`/`awaiting_input`) | ✅ Implemented | `delay`/`poll`/`human`/`webhook-receive` waits are pure DB state                             |
| Per-node retry with backoff                    | ✅ Implemented | `retry.max_attempts` + fixed/exponential backoff, offloaded to the scheduler                  |
| Synchronous compatibility mode                 | ✅ Implemented | `wait: true` on `start-orchestration-run`                                                     |
| Run lifecycle webhook events                   | ✅ Implemented | `orchestration_runs.started` / `.awaiting_input` / `.succeeded` / `.failed`                   |
| Queue abstraction + Postgres driver            | ❌ Not started | `SELECT … FOR UPDATE SKIP LOCKED`; decouples execution from the API process                   |
| Run-scoped node idempotency keys               | ❌ Not started | Documented gap: node side effects can repeat across a retry/redrive today                     |
| Worker pool (separate process option)          | ❌ Not started | API process remains a valid worker for single-process deployments                             |
| Concurrency limits (per project + global)      | ❌ Not started |                                                                                              |
| Pluggable driver interface + SQS driver        | ❌ Not started | For deployments that standardize on a managed queue                                           |

## Implementation Phases

### Phase 1 — Postgres Queue Driver + Idempotency Keys ❌ Not started

**Goal:** Run execution becomes a queue-consuming worker loop with
at-least-once delivery and idempotent node execution — closing the documented
"side effects may repeat" gap.

**Deliverables:**

- Queue abstraction (`enqueue`, `claim`, `ack`, `retry`) with a **Postgres
  driver** as the self-hosted default: a `run_tasks` table claimed with
  `SELECT … FOR UPDATE SKIP LOCKED` — no new infrastructure
- `startOrchestrationRun` becomes enqueue-only (the existing `wait: true`
  keeps synchronous behavior for dev/tests); the worker loop picks a task,
  loads the checkpoint, executes the next ready round, persists, re-enqueues
  the continuation
- **Run-scoped idempotency keys** per node execution
  (`run_id:node_id:attempt`): recorded before side-effecting executors run
  (tool calls, agent generations); a redelivered task that finds a completed
  key reuses the stored output instead of re-executing
- The existing lease/reaper machinery is retargeted at queue tasks (a claimed
  task whose worker dies is redelivered after lease expiry)
- The scheduler tick and the worker loop remain runnable inside the API
  process, so single-process deployments keep working unchanged

**Acceptance criteria:**

- Two workers claiming concurrently against a seeded `run_tasks` table never
  claim the same task (concurrency test over `SELECT … FOR UPDATE SKIP LOCKED`)
- A claimed task whose lease is left to expire is redelivered and the run
  completes; for every `run_id:node_id:attempt` idempotency key there is
  exactly **one** `NodeExecution` side-effect execution (count == 1 asserted
  over the table)
- A redelivered task whose node already holds a completed idempotency key
  reuses the stored output: the side-effecting executor is invoked exactly
  once, asserted at a local fake HTTP server (per the tests.md mocking rules)
- The HTTP tool executor forwards the key as an `Idempotency-Key` request
  header, asserted at the same fake server
- `start-orchestration-run` without `wait` returns `status: "queued"` and
  executes no node inside the HTTP request; the existing `wait: true` test
  suite passes unchanged
- Single-process mode (worker loop inside the API process) passes the full
  existing orchestration test suite with no config changes

**Unlocks:** True at-least-once semantics — a redeploy mid-run neither loses
the run nor repeats a completed side effect. Also the write-side prerequisite
for idempotent [usage metering](./prd-usage-metering.md).

### Phase 2 — Concurrency Limits ❌ Not started

**Goal:** Parallelism is bounded per tenant and globally, protecting both
noisy-neighbor fairness and LLM provider rate limits.

**Deliverables:**

- `max_concurrent_runs` per project (default unlimited; enforced at claim
  time — excess tasks stay queued, which is what a queued scheduled
  [trigger](../packages/website/docs/modules/triggers.md) leans on)
- Global worker concurrency setting (`ORCHESTRATION_WORKER_CONCURRENCY`)
- Queue depth and claim latency exposed via
  `GET /api/v1/orchestrations/queue/stats` (see
  [Queue metrics endpoint](#queue-metrics-endpoint)), guarded by a new
  `orchestrations:GetQueueStats` action in
  `packages/server/src/permissions/orchestrations.json`

**Acceptance criteria:**

- With `max_concurrent_runs = 1` on a project and three runs started, at most
  one run is `in_progress` at any poll, and all three eventually reach
  `succeeded` (no run is dropped or failed by the limit)
- With `ORCHESTRATION_WORKER_CONCURRENCY=2` and a 20-task backlog, the number
  of claimed, lease-valid tasks never exceeds 2 at any point
- Tasks held back by a project limit stay queued and are claimed (not
  re-enqueued with incremented `attempts`, not failed) once a slot frees
- `GET /api/v1/orchestrations/queue/stats` returns the documented snake_case
  shape with every key present; returns `401` unauthenticated and `403`
  without `orchestrations:GetQueueStats`
- `GET /health` continues to return `{"status":"ok"}` unchanged (compose
  healthchecks unaffected)

**Unlocks:** Many projects running cycles in parallel without starving each
other or tripping provider rate limits.

### Phase 3 — Pluggable Driver + SQS ❌ Not started

**Goal:** Deployments that standardize on a managed queue can ride it instead
of Postgres, behind the same abstraction.

**Deliverables:**

- Driver selection via environment (`ORCHESTRATION_QUEUE_DRIVER=postgres|sqs`)
- SQS driver (visibility timeout maps to the claim lease; DLQ maps to
  exhausted retries → run `failed` + exception per
  [prd-approvals.md](./prd-approvals.md))
- Load hardening: soak test with 10+ projects running concurrent scheduled
  cycles

**Acceptance criteria:**

- A shared driver-conformance contract suite (`enqueue` / `claim` / `ack` /
  `retry`, lease expiry → redelivery, `available_at` ordering) passes against
  **both** the Postgres and SQS drivers
- `ORCHESTRATION_QUEUE_DRIVER` unset defaults to `postgres` — existing
  deployments see no behavior change; an unknown value fails startup with a
  clear error
- On SQS, exhausted retries land the run in `failed` with an exception
  recorded, matching the Postgres driver's behavior
- Soak test passes with explicit thresholds — 10 projects running concurrent
  scheduled cycles for 30 minutes:
  - ≥ 500 runs reach a terminal state during the window
  - non-injected run failure rate < 1%
  - p95 claim latency < 2,000 ms while queue depth ≤ 100
  - **zero** double executions: no idempotency key has more than one
    side-effect execution across the entire soak
  - **zero** stuck runs: every started run is terminal
    (`succeeded`/`failed`/`canceled`) or legitimately parked
    (`sleeping`/`awaiting_input`) at the end of the window

**Unlocks:** Production deployments on managed-queue infrastructure without
forking the runner.

## Key Concepts

### Why a queue when durable execution already exists

Today the process that *starts* a run also *drives* it (the reaper only
rescues orphans). A queue makes driving work claimable by any worker: the API
tier can stay request-only, workers scale horizontally, and backpressure
(concurrency limits, overlap `queue` policy) falls out of queue semantics
instead of bespoke checks.

### Idempotency contract

At-least-once delivery means every node executor must tolerate replay. The
platform provides the key (`run_id:node_id:attempt`) and the replay check;
executors with external side effects (HTTP tools) additionally forward the key
as an `Idempotency-Key` header so downstream services can dedupe. LLM
generations dedupe on the same key in the metering layer
([prd-usage-metering.md](./prd-usage-metering.md)) — a replayed node never
double-counts tokens.

### What this PRD does not do

No sub-workflow signals, no arbitrary external event triggers, no priority
lanes. Durable execution stays scoped to checkpoint-resume of DAG runs —
anything more waits for demonstrated demand.

## Data Model

### RunTask (queue table, Postgres driver)

| Column          | Type      | Description                                          |
| --------------- | --------- | ---------------------------------------------------- |
| id              | INTEGER   | PK                                                   |
| publicId        | VARCHAR   | UNIQUE, `orch_task_` prefix (registered in `packages/postgresdb/src/utils/publicId.ts`) |
| runId           | INTEGER   | FK → OrchestrationRun                                |
| kind            | VARCHAR   | `continue` \| `wake` \| `resume`                     |
| availableAt     | TIMESTAMP | Not claimable before this time (backoff, delays)     |
| claimedAt       | TIMESTAMP | NULL until claimed                                   |
| leaseExpiresAt  | TIMESTAMP | Redelivery deadline for the claiming worker          |
| attempts        | INTEGER   | Delivery attempts                                    |
| createdAt       | TIMESTAMP |                                                      |

### NodeExecution (existing — new column)

| Column          | Type    | Description                                                   |
| --------------- | ------- | -------------------------------------------------------------- |
| idempotencyKey  | VARCHAR | UNIQUE; `run:node:attempt`; written before side effects run    |

> `RunTask` rows are never returned by any endpoint today, but the table
> follows the repo rule that every model carries a `publicId` with a
> registered prefix — `orch_task_`, consistent with `orch_` / `orch_run_` —
> so queue stats and future admin tooling can reference tasks safely.

## REST API

One new endpoint (Phase 2), plus behavior changes:

- `start-orchestration-run` enqueues instead of spawning in-process
  (`wait: true` unchanged)
- `GET /api/v1/orchestration-runs/{run_id}` — `status: "queued"` now means
  "task enqueued, not yet claimed" (the status value already exists)
- `GET /api/v1/orchestrations/queue/stats` — queue metrics (see below)

### Queue metrics endpoint

**Decision:** the existing `GET /health` route is an unauthenticated liveness
probe provided by `@ttoss/http-server` (`addHealthCheck` in
`packages/server/src/app.ts`) and consumed by the docker-compose
healthchecks — it stays a bare `{"status":"ok"}`. Queue metrics include
per-project tenancy data, so they live behind auth as a normal `/api/v1`
route instead: `GET /api/v1/orchestrations/queue/stats`, guarded by
`orchestrations:GetQueueStats` (new action in
`packages/server/src/permissions/orchestrations.json`, intended for
admin/operator policies).

Response (snake_case, per the case convention):

```json
{
  "driver": "postgres",
  "queue_depth": 12,
  "claimed_tasks": 3,
  "oldest_queued_age_seconds": 4.2,
  "claim_latency_ms": {
    "p50": 18,
    "p95": 240,
    "window_seconds": 300
  },
  "per_project": [
    { "project_id": "proj_V1StGXR8Z5jdHi6B", "queued": 5, "claimed": 1 }
  ]
}
```

- `queue_depth` — tasks with `claimed_at IS NULL` and `available_at <= now()`
  (backoff-delayed tasks are excluded; they are not claimable yet)
- `claim_latency_ms` — time from `available_at` to `claimed_at`.
  **Decision:** percentiles are computed in-process over a 5-minute ring
  buffer of recent claims (`window_seconds: 300`) rather than via a metrics
  stack — no new infrastructure, matching the Postgres-driver philosophy;
  both values are `null` when no claims happened in the window
- `per_project` — one row per project with queued or claimed tasks,
  identified by the project's public ID
