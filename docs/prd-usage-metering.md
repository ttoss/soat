# PRD: Usage Metering

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G5).
> Status and sequencing live in the [SOAT Delivery Roadmap](./roadmap.md).
> Depends on the idempotency keys from
> [prd-orchestration-queue.md](./prd-orchestration-queue.md) for
> exactly-once accounting under retries; feeds the `usage.*` guard context in
> [guardrails](../packages/website/docs/modules/guardrails.md) and the token/cost windows in
> [prd-quotas.md](./prd-quotas.md).

> The shipped surface (event + component model, price book, aggregation,
> thresholds, compute metering) is documented in the
> [Usage module doc](../packages/website/docs/modules/usage.md). This PRD now
> tracks only the outstanding work.

## Pending Work

| Component                                  | Status                     | Notes                                                                |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------|
| Provider-call instrumentation coverage     | 🟡 Partial                  | Wired for agent generations, conversations, and orchestration agent nodes; **extraction, discussions, and chats still pending** |
| Storage metering                           | ❌ Not started              | Daily per-project snapshot job (Phase 5)                             |
| API-request metering                       | ❌ Not started              | Flush-aggregated counters; last in sequence (Phase 6)               |
| `usage.*` guard context / per-run ceiling  | ⏭️ Deferred                 | Needs the guardrail evaluator ([guardrails](../packages/website/docs/modules/guardrails.md)), which is unbuilt. The run roll-up provides the cumulative signal an interim orchestration `condition` node can read (Phase 7) |

## Coverage — Remaining LLM Paths 🟡

The write side is a single choke point (`recordGenerationUsage`), so every
metered path meters identically. Agent generations (non-stream, streaming, and
the tool-outputs continuation path), conversations, and orchestration agent
nodes are metered. **Extraction, discussions, and chats are not yet metered** —
they must be routed through the same `recordGenerationUsage` side-effect so no
LLM call silently skips metering.

## Meter Types (pending emitters)

The event + component schema and per-component pricing already exist, so the
remaining infra dimensions are emitter-only work. `compute_execution` shipped
(P4); `storage` and `api_request` remain:

| `meter_type`  | What one event records                       | Components  | Emitter (write path)                                                                 |
| ------------- | -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `api_request` | A batch of API requests served for a project | `request`   | Counting middleware, aggregated in memory and flushed periodically — **never one row per request** |
| `storage`     | One project's stored bytes for one day       | `gb_day`    | Daily snapshot job summing `File.size` + document/chunk byte counts                   |

Platform SKUs price these via a `soat` provider (`model` names the billable
unit, e.g. `request`, `gb-day`); a missing price row records the quantity with
`cost_usd = null` — usage is never lost because pricing lagged.

## Implementation Phases

### Phase 5 — Storage Metering ❌ Not started

**Depends on the event + component schema (shipped).** A daily snapshot job
writes one `storage` meter row per project (`quantity` = GB-days: total bytes
across `File.size` plus document/chunk content, sampled once per UTC day;
idempotency key `storage:{project_id}:{YYYY-MM-DD}` so a re-run job cannot
double-count). Priced via a `soat`/`gb-day` SKU.

**Unlocks:** The storage line of the project bill; "which project's knowledge
base is costing us" visibility.

### Phase 6 — API-Request Metering ❌ Not started

**Depends on the event + component schema. Deliberately last** — least
dollar-material and the only dimension needing new infrastructure. A counting
middleware aggregates requests in memory per `(project, api_key)` and flushes
one `api_request` meter row per counter per flush interval (`quantity` =
request count; idempotency key from the flush window). One row **per request**
is explicitly rejected — it would multiply every agent tool loop into meter
writes. Enforcement stays with [prd-quotas.md](./prd-quotas.md)'s atomic
counters; this phase only prices.

**Unlocks:** The request line of the project bill.

### Phase 7 — Budget Guard Integration ⏭️ Deferred

> Blocked on the guardrail evaluator and `usage.*` guard context
> ([guardrails](../packages/website/docs/modules/guardrails.md)), which are unbuilt. The per-run
> token-ceiling issue (#486) was deferred for the same reason. Interim: an
> orchestration `condition` node can read the run's cumulative usage (via the
> run roll-up) and route to an abort path — a modelable pattern, not a platform
> guarantee.

**Goal:** Runaway cycles trip fail-closed like any other guard.

**Deliverables:**

- `usage.*` context provider for the
  [guardrail evaluator](../packages/website/docs/modules/guardrails.md):
  `usage.cost_usd(window)`, `usage.tokens(window)`, per project
- Documented pattern: a class-B rule guarded by
  `{'<': [{var: 'usage.cost_usd_24h'}, {var: 'project.context.cost_ceiling'}]}`
  aborts (tripwire → exception) when the ceiling is hit

**Unlocks:** Hard per-project spend ceilings enforced deterministically at the
tool boundary.

## Risks

- **Request-metering write amplification** — one row per request would turn
  every agent tool loop into meter writes. Mitigation: flush-aggregated
  counters are a hard design constraint (Phase 6), mirroring the existing
  rule that raw meter rows never emit webhooks.
- **Storage snapshot drift** — a daily sample misses intra-day churn; a
  project that uploads and deletes 100 GB between samples meters zero.
  Accepted for v1 (bounded by the sampling interval and symmetric across
  projects); event-driven byte accounting is a noted future refinement.
- **Non-LLM meters without prices** — operators who never define platform
  SKUs get `cost_usd = null` infra rows. Accepted: identical to the existing
  missing-token-price behavior — quantities are still recorded and retroactive
  pricing is **not** offered (write-time pricing is the invariant), so
  operators should define SKUs before enabling infra billing.

## Backlog

- **Event-driven storage byte accounting** — replace the daily storage
  snapshot with incremental byte deltas on file/document mutation, eliminating
  intra-day sampling drift.
