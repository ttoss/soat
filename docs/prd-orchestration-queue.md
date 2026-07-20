# PRD: Orchestration Queue-Backed Execution

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G2).
> This PRD covers the **remaining** durability work. The core durable runtime
> already shipped — see
> [orchestrations.md → Durable Background Execution](../packages/website/docs/modules/orchestrations.md#durable-background-execution).

> **Decision (2026-07-20):** the seven design forks for Phase 1 were resolved
> ahead of implementation. They are recorded in
> [Resolved design decisions](#resolved-design-decisions) and woven into the
> phase deliverables below. Where an older revision of this document was
> ambiguous, the decisions section wins.

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
| Worker pool (separate process option)          | ❌ Not started | Thin `worker.ts` entrypoint in P1; deploy/ops tooling lands with Phase 2                      |
| Concurrency limits (per project + global)      | ❌ Not started |                                                                                              |
| Pluggable driver interface + SQS driver        | ❌ Not started | For deployments that standardize on a managed queue                                           |

## Resolved design decisions

All dated 2026-07-20. Each was evaluated on correctness, spec compliance,
implementation effort, long-run maintainability, and migration risk; six of
the seven had a dominant option, and the seventh (worker packaging) was
resolved by scoping choice.

### D1 — Claim mechanism: `SELECT … FOR UPDATE SKIP LOCKED`

Task claiming uses a **new batched claim path** over `run_tasks` with
`SELECT … FOR UPDATE SKIP LOCKED`, not the existing `createSweep`
conditional-`UPDATE` claim. Rationale: the Phase 1 acceptance criteria assert
concurrency over SKIP LOCKED directly; batched claims avoid per-row
contention; it is the standard Postgres-queue idiom. The existing
`createScheduler` timer plumbing (interval, env override, unref'd timer,
idempotent start/stop) **is reused** — only the claim strategy inside the tick
is new.

### D2 — `attempt` in the idempotency key is the node retry attempt

The key is `{run_id}:{node_id}:{attempt}` where `attempt` is the **existing
node retry attempt** (`OrchestrationNodeExecution.attempt`, minted by the
per-node retry policy) — **not** the task delivery counter
(`RunTask.attempts`). Consequences, which are the point:

- A **redelivery** (task lease expired, another worker claims it) replays the
  *same* `(run, node, attempt)` → the key already exists → the stored output
  is reused and the side-effecting executor is **not** re-invoked.
- A **real retry** (attempt N failed; policy schedules attempt N+1) is a *new*
  key → the executor **is** re-invoked, which is what a retry means.

Keying on the delivery counter would make every redelivery look like a fresh
execution and double-fire the side effect — the exact bug this phase closes.

### D3 — `wait: true` stays in-process, sharing the executor

Synchronous mode (`wait: true`) keeps driving the run **inside the HTTP
request**, bypassing the queue claim/lease entirely, but routes node execution
through the **same executor path** that writes and checks idempotency keys.
One dedup code path, two drive paths. The existing `wait: true` test suite
must pass unchanged — an explicit Phase 1 acceptance criterion.

### D4 — Worker packaging: extractable module + thin entrypoint

The worker loop is written as an **extractable module** that runs inside the
API process by default (single-process deployments keep working with no
config change). Phase 1 also ships a **thin `worker.ts` entrypoint** that
starts only the scheduler tick + worker loop — satisfying the
"separate-process option" deliverable — but **no** deploy tooling (no compose
service, no dedicated healthcheck/CI wiring). That ops hardening lands with
Phase 2, when concurrency limits make a real worker fleet meaningful.

### D5 — Idempotency key row is written *before* the side effect

For **side-effecting nodes** (tool calls, agent generations), the
`NodeExecution` row — carrying the idempotency key, `status: 'running'`, and
resolved input — is inserted **before** the executor dispatches, then updated
in place to `completed`/`failed` with output/error. The replay check is:
a `completed` row with this key exists → reuse its stored `output`; a
`running` row whose task lease expired → the redelivering worker takes over
under the same key (see [Idempotency contract](#idempotency-contract) for the
honest at-least-once boundary). **Pure nodes** (`condition`, `artifact`,
mapping-only) have no external effect and keep today's record-after-execution
behavior.

### D6 — Task lifecycle: parking stays DB state; wakes enqueue tasks

`sleeping` / `awaiting_input` parking remains **pure run-row state** — no open
`RunTask` is held while parked. Transitions mint tasks:

| Event | Task minted |
| --- | --- |
| Run started (no `wait`) | `continue` |
| Round completed, more rounds remain | `continue` (re-enqueued by the worker) |
| `wakeDueRuns` finds a due sleeping run (delay/poll/retry backoff) | `wake` |
| Human input / webhook receive / approval resolution applied | `resume` |

The scheduler sweeps (`wakeDueRuns`, the reaper) stop driving runs inline;
their handlers **enqueue** instead. The task lease (`lease_expires_at` on
`RunTask`) becomes the redelivery mechanism. The run-level lease + reaper are
**kept as a backstop** for the one path that still drives without a task —
synchronous `wait: true` runs orphaned by a mid-request crash — but the
reaper's handler changes from re-driving inline to enqueuing a `continue`
task.

### D7 — HTTP tools forward the raw key as `Idempotency-Key`

The HTTP tool executor forwards the literal `run:node:attempt` string as the
`Idempotency-Key` request header — no hashing. It is debuggable, stable across
redeliveries by construction, and matches the internal key so a downstream
incident can be correlated end-to-end. This format is a semi-public contract:
downstream services are expected to dedupe on it.

## Implementation Phases

### Phase 1 — Postgres Queue Driver + Idempotency Keys ❌ Not started

**Goal:** Run execution becomes a queue-consuming worker loop with
at-least-once delivery and idempotent node execution — closing the documented
"side effects may repeat" gap.

**Deliverables:**

- Queue abstraction (`enqueue`, `claim`, `ack`, `retry`) with a **Postgres
  driver** as the self-hosted default: a `run_tasks` table claimed in batches
  with `SELECT … FOR UPDATE SKIP LOCKED` (**D1**) — no new infrastructure.
  The tick/timer machinery reuses the existing `createScheduler` plumbing.
- `startOrchestrationRun` becomes enqueue-only — it inserts a `continue` task
  and returns `status: "queued"`. The existing `wait: true` path keeps
  synchronous in-process behavior for dev/tests, sharing the
  idempotency-aware executor (**D3**).
- The worker loop (extractable module, **D4**): claim a batch, and per task —
  load the run checkpoint, execute the next ready round, persist, `ack`, and
  re-enqueue a `continue` task if rounds remain. Ships with a thin
  `worker.ts` entrypoint that runs only the scheduler tick + worker loop; the
  API process remains a valid (and default) single-process worker.
- **Run-scoped idempotency keys** per node execution:
  `{run_id}:{node_id}:{attempt}` where `attempt` is the node **retry**
  attempt (**D2**). For side-effecting executors the keyed `NodeExecution`
  row is inserted `running` *before* dispatch and updated in place after
  (**D5**); a redelivered task that finds a `completed` key reuses the stored
  output instead of re-executing.
- The HTTP tool executor forwards the raw key as an `Idempotency-Key` header
  (**D7**).
- Scheduler sweeps retargeted at the queue (**D6**): `wakeDueRuns` enqueues
  `wake` tasks; human-input/webhook resumption enqueues `resume` tasks; the
  run-lease reaper is kept as a backstop for orphaned synchronous runs and
  now enqueues a `continue` task instead of re-driving inline. Task-lease
  expiry drives redelivery of claimed tasks.
- The scheduler tick and the worker loop remain runnable inside the API
  process, so single-process deployments keep working unchanged.

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
- A node that fails attempt 1 and retries executes attempt 2 under a **new**
  key (`…:2`) — the retry is not suppressed by attempt 1's key (guards the D2
  semantics from both directions)
- The HTTP tool executor forwards the key as an `Idempotency-Key` request
  header whose value is the literal `run:node:attempt` string, asserted at
  the same fake server
- `start-orchestration-run` without `wait` returns `status: "queued"` and
  executes no node inside the HTTP request; the existing `wait: true` test
  suite passes unchanged
- Single-process mode (worker loop inside the API process) passes the full
  existing orchestration test suite with no config changes
- `node worker.ts` (the thin entrypoint) drains a seeded queue to completion
  with the API process stopped — proves the separate-process option is real

**Unlocks:** True at-least-once semantics — a redeploy mid-run neither loses
the run nor repeats a completed side effect. Also the write-side prerequisite
for idempotent [usage metering](./prd-usage-metering.md), and the `RunTask`
substrate async [evaluations](./prd-evaluations.md) Phase 2 rides
(`kind: eval_item`).

### Phase 2 — Concurrency Limits ❌ Not started

**Goal:** Parallelism is bounded per tenant and globally, protecting both
noisy-neighbor fairness and LLM provider rate limits.

**Deliverables:**

- `max_concurrent_runs` per project (default unlimited; enforced at claim
  time — excess tasks stay queued, which is what a queued scheduled
  [trigger](../packages/website/docs/modules/triggers.md) leans on)
- Global worker concurrency setting (`ORCHESTRATION_WORKER_CONCURRENCY`)
- Deploy/ops hardening for the separate-process worker deferred from Phase 1
  (**D4**): compose service, healthcheck, graceful shutdown (finish claimed
  tasks, stop claiming), smoke coverage
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
platform provides the key (`run_id:node_id:attempt` — attempt being the node
**retry** attempt, per **D2**) and the replay check; the keyed record is
written *before* the side effect runs (**D5**), so a task redelivered after
the effect completed finds the `completed` key and reuses its stored output.

The honest boundary: a worker that crashes *between* firing the side effect
and marking the key `completed` leaves a `running` key; the redelivering
worker re-executes under the **same** key. That window is irreducible with
at-least-once delivery — which is why executors with external side effects
(HTTP tools) additionally forward the key as an `Idempotency-Key` header
(**D7**) so downstream services can dedupe, and why LLM generations dedupe on
the same key in the metering layer
([prd-usage-metering.md](./prd-usage-metering.md)) — a replayed node never
double-counts tokens even when it double-invokes.

Retries are deliberately **not** deduped: attempt N+1 is a new key and
executes for real. Suppressing a retry with attempt N's key would silently
turn every retry policy into a no-op.

### Task kinds and where tasks come from

`RunTask.kind` encodes why a run needs driving (**D6**):

- **`continue`** — a round finished (or the run just started) and more rounds
  remain; also what the reaper enqueues for an orphaned synchronous run.
- **`wake`** — a parked wait (`delay` / `poll` interval / retry backoff) came
  due; enqueued by `wakeDueRuns` instead of driving inline.
- **`resume`** — external input arrived (`human` node submission,
  `webhook-receive`, approval resolution) and was applied to run state.

Parking itself holds **no** task: a `sleeping` / `awaiting_input` run is pure
DB state, exactly as shipped. Tasks exist only when there is work a worker
could pick up right now (or at `available_at`).

### Synchronous mode

`wait: true` bypasses the queue: the request drives the run in-process through
the same idempotency-aware executor (**D3**). It exists for dev, tests, and
short deterministic runs; it gains none of the queue's crash-recovery
properties beyond the pre-existing run-lease backstop, and that is
acceptable — a caller holding a synchronous HTTP request open observes the
failure directly.

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
| attempts        | INTEGER   | Delivery attempts — **never** part of the idempotency key (D2) |
| createdAt       | TIMESTAMP |                                                      |

### NodeExecution (existing — new column, new status)

| Column          | Type    | Description                                                   |
| --------------- | ------- | -------------------------------------------------------------- |
| idempotencyKey  | VARCHAR | UNIQUE; `{run_id}:{node_id}:{attempt}` (attempt = node retry attempt, D2); written **before** side effects run (D5); NULL for pure nodes |
| status          | VARCHAR | existing enum gains `running` — the pre-insert state of a side-effecting node between dispatch and completion (D5) |

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
