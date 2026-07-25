# PRD: Usage Metering

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G5).
> Status and sequencing live in the [SOAT Delivery Roadmap](./roadmap.md).
> Depends on the idempotency keys from
> [prd-orchestration-queue.md](./prd-orchestration-queue.md) for
> exactly-once accounting under retries; feeds the `usage.*` guard context in
> [guardrails](../packages/website/docs/modules/guardrails.md) and the token/cost windows in
> [quotas](../packages/website/docs/modules/quotas.md#windows-and-counters).

> The shipped surface (event + component model, price book, aggregation,
> thresholds, compute metering) is documented in the
> [Usage module doc](../packages/website/docs/modules/usage.md). This PRD now
> tracks only the outstanding work.

## Pending Work

| Component                                  | Status                     | Notes                                                                |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------|
| Provider-call instrumentation coverage     | ✅ Shipped                  | Every LLM path meters — agent generations plus the standalone chat, discussion, and memory completions |
| Storage metering                           | ✅ Shipped                  | Daily per-project snapshot job (Phase 5)                             |
| API-request metering                       | ✅ Shipped                  | Flush-aggregated counters; last in sequence (Phase 6)               |
| `usage.*` guard context                    | ✅ Shipped                  | `soat.usage.cost_usd_{1h,24h,7d,30d}` and `soat.usage.tokens_{24h,30d}` resolve fail-closed in the [guardrail](../packages/website/docs/modules/guardrails.md) evaluator (Phase 7) |
| Per-run cumulative ceiling                 | ⏭️ Deferred                 | No run-scoped guard key exists; the run roll-up is the interim signal an orchestration `condition` node reads |

## Coverage — All LLM Paths ✅

Every provider call the platform makes writes an `llm_tokens` event, through one
of two shared choke points:

- `recordGenerationUsage` — agent generations (non-stream, streaming, and the
  tool-outputs continuation path), conversations, and orchestration agent nodes,
  all keyed on the generation's public id.
- `recordCompletionUsage` — the paths that create no `Generation` row: chat
  completions (stateless and chat-scoped, streaming and not), discussion turns,
  and memory fact extraction and consolidation. Attribution is explicit rather
  than read off a generation, so `generation_id` and `trace_id` are null and
  `agent_id` is set only where the call is anchored to an agent. These calls have
  no replay identity, so the idempotency key is unique per call
  (`completion:{source}:{uuid}`).

Live behaviour is documented in the
[Usage module doc](../packages/website/docs/modules/usage.md#coverage).

Platform meter types (`compute_execution`, `storage`, `api_request`) price via a
`soat` provider SKU (`model` names the billable unit, e.g. `compute-second`,
`gb-day`, `request`); a missing price row records the quantity with
`cost_usd = null` — usage is never lost because pricing lagged.

## Implementation Phases

### Phase 5 — Storage Metering ✅ Shipped

**Depends on the event + component schema (shipped).** A daily snapshot job
writes one `storage` meter row per project (`quantity` = GB-days: total bytes
across `File.size` plus document/chunk content, sampled once per UTC day;
idempotency key `storage:{project_id}:{YYYY-MM-DD}` so a re-run job cannot
double-count). Priced via a `soat`/`gb-day` SKU.

**Unlocks:** The storage line of the project bill; "which project's knowledge
base is costing us" visibility.

### Phase 6 — API-Request Metering ✅ Shipped

**Depends on the event + component schema. Deliberately last** — least
dollar-material and the only dimension needing new infrastructure. A counting
middleware aggregates requests in memory per `(project, api_key)` and flushes
one `api_request` meter row per counter per flush interval (`quantity` =
request count; idempotency key from the flush window). One row **per request**
is explicitly rejected — it would multiply every agent tool loop into meter
writes. Enforcement stays with the
[quotas](../packages/website/docs/modules/quotas.md#windows-and-counters)
atomic counters; this phase only prices.

**Unlocks:** The request line of the project bill.

### Phase 7 — Budget Guard Integration ✅ Shipped (project windows)

**Goal:** Runaway spend trips fail-closed like any other guard.

**Delivered:** the `usage.*` context provider for the
[guardrail evaluator](../packages/website/docs/modules/guardrails.md) —
`soat.usage.cost_usd_{1h,24h,7d,30d}` and `soat.usage.tokens_{24h,30d}`,
resolved per project at evaluation time and left `null` (fail-closed) when the
usage query throws. The class-B ceiling pattern
(`{'<': [{var: 'soat.usage.cost_usd_24h'}, 1000]}`) is documented in the
[guardrails module doc](../packages/website/docs/modules/guardrails.md).

**Unlocks:** Hard per-project spend ceilings enforced deterministically at the
tool boundary.

**Still open — per-run cumulative ceiling (#486).** The shipped keys are
*windowed per project*, which is the wrong granularity for aborting a single
runaway run. No run-scoped key (`usage.run_tokens` / `usage.run_cost_usd`) exists
in the guard-context catalog. Interim: an orchestration `condition` node reads
the run's cumulative usage via the run roll-up and routes to an abort path — a
modelable pattern, not a platform guarantee.

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
