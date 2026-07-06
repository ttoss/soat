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

**Unlocks:** True at-least-once semantics — a redeploy mid-run neither loses
the run nor repeats a completed side effect. Also the write-side prerequisite
for idempotent [usage metering](./prd-usage-metering.md).

### Phase 2 — Concurrency Limits ❌ Not started

**Goal:** Parallelism is bounded per tenant and globally, protecting both
noisy-neighbor fairness and LLM provider rate limits.

**Deliverables:**

- `max_concurrent_runs` per project (default unlimited; enforced at claim
  time — excess tasks stay queued, which is what `overlap_policy: queue` in
  [prd-schedules.md](./prd-schedules.md) leans on)
- Global worker concurrency setting (`ORCHESTRATION_WORKER_CONCURRENCY`)
- Queue depth and claim latency exposed on the health/metrics endpoint

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

## REST API

No new public endpoints. Behavior changes:

- `start-orchestration-run` enqueues instead of spawning in-process
  (`wait: true` unchanged)
- `GET /api/v1/orchestration-runs/:id` — `status: "queued"` now means
  "task enqueued, not yet claimed" (the status value already exists)
