# Usage Roadmap

The ordered task list for taking usage metering from "per-generation LLM
tokens" (shipped) to "billing-grade, multi-dimension project cost" —
per-run receipts, a per-project aggregate, and compute/storage/request
metering. Specs live in the referenced PRDs; this page only sequences the
work.

**Primary PRD:** [prd-usage-metering.md](./prd-usage-metering.md)
**Related:** [prd-quotas.md](./prd-quotas.md) (enforcement),
[prd-guardrails.md](./prd-guardrails.md) (`usage.*` guard context),
[prd-orchestration-queue.md](./prd-orchestration-queue.md) (node idempotency
keys), [prd-agent-operations.md](./prd-agent-operations.md) (G5 umbrella).

## Shipped (baseline)

- ✅ Append-only usage rows per completed generation, idempotent, with
  trace/trigger/action attribution (#483, #484, #485, #557). _Milestone 2
  replaced the original token-centric `UsageMeter` with the `UsageEvent` +
  `UsageComponent` model._
- ✅ Versioned `PriceBook` with three-tier resolution and write-time
  `cost_usd` (#488, #502/#504); default seeding removed — operators own
  price data (#546)
- ✅ `GET /usage/meters` (raw list) and `GET /usage/receipt`
  (per-generation receipt)
- ✅ **Decision:** USD is the fixed metering currency
  ([details](./prd-usage-metering.md#meter-type-generalization))

## Milestone 1 — Per-run cost (billing-grade "one action = one receipt") ✅ Done

> [Metering Phase 3a](./prd-usage-metering.md#phase-3a--runnode-attribution--run-roll-up--done)
>
> **Shipped (#562).** Every generation an orchestration node dispatches now
> meters with its `run_id` + `node_id` (threaded through the generation
> metadata), a run exposes the summed roll-up, and the initiating trigger is
> propagated onto in-run generations.

| # | Task | Notes |
|---|------|-------|
| 1.1 ✅ | Thread orchestration run/node context into `recordGenerationUsage`; stop hardcoding `run_id`/`node_id` to `null` | Carried on generation metadata; the run's public id is resolved to its FK at write time |
| 1.2 ✅ | Scope the meter idempotency key by node execution | Inside a run the key is `run:<run>:node:<node>`, so a replayed node upserts into a no-op ([prd-orchestration-queue.md](./prd-orchestration-queue.md)) |
| 1.3 ✅ | Per-run receipt: `GET /usage/receipt?run_id=…` | Same shape as the generation receipt, summed across the run |
| 1.4 ✅ | Surface `usage` totals (tokens, `cost_usd`) on the orchestration-run response | `usage` object on `GET /orchestration-runs/{run_id}`; omitted from list responses |
| 1.5 ✅ | Finish in-run trigger/action attribution (#485 remainder) | `OrchestrationRun.trigger_id` propagates the initiating trigger onto in-run generations; node id serves as the in-run action |

## Milestone 2 — Schema generalization (before billing freezes on tokens) ✅ Done

> [Metering Phase 3b](./prd-usage-metering.md#phase-3b--meter-type-generalization-schema--done)
> and the [Meter-Type Generalization](./prd-usage-metering.md#meter-type-generalization)
> design. Deliberately sequenced before any billing consumer (credits PRD)
> hardcodes "a meter row is tokens".
>
> **Shipped as a ground-up redesign rather than additive columns.** Instead of
> privileging tokens on `UsageMeter`, metering is now a uniform **`UsageEvent`
> (one metered occurrence) + `UsageComponent` (one priced dimension)** model:
> `llm_tokens` is an event with `input_tokens`/`output_tokens`/`cached_tokens`
> components (+ a non-billable `reasoning_tokens` detail); infra types are the
> same shape with different components. `PriceBook` prices one component of a
> SKU per row. No meter type is privileged, and new dimensions are emitter-only.

| # | Task | Notes |
|---|------|-------|
| 2.1 ✅ | `UsageEvent` + `UsageComponent` carry `meter_type` and per-component `quantity`/`unit` | Breaking rebuild (old `UsageMeter` dropped); token columns gone |
| 2.2 ✅ | `PriceBook` prices one component of a SKU (`meter_type`, `component`, `unit`, `unit_price`); per-component upsert validation | `(provider, model)` generalizes to a SKU, e.g. `soat`/`compute-second` |
| 2.3 ✅ | Cost is uniform `quantity × unit_price` per component; event cost is their sum | token components priced per token |
| 2.4 ✅ | `meter_type` filter on `GET /usage/meters`; receipt gains a `by_meter_type` breakdown | |

## Milestone 3 — Project aggregate + alerts (queryable, pushable)

> [Metering Phase 3c](./prd-usage-metering.md#phase-3c--aggregation--events--not-started)

| # | Task | Notes |
|---|------|-------|
| 3.1 | `GET /api/v1/usage?project_id&from&to&group_by=model\|agent\|run\|day\|meter_type` | The per-project cost-by-date-range/by-category query |
| 3.2 | `UsageThreshold` table + CRUD | Fire-state / hysteresis rules in [Usage Thresholds](./prd-usage-metering.md#usage-thresholds) |
| 3.3 | `usage.threshold_crossed` webhook | Once-per-window / 10% re-arm band |

## Milestone 4 — Infra meter emitters (the "+ infra" half of the bill)

> Metering [Phase 4](./prd-usage-metering.md#phase-4--compute-metering-compute_execution--not-started)
> / [Phase 5](./prd-usage-metering.md#phase-5--storage-metering--not-started)
> / [Phase 6](./prd-usage-metering.md#phase-6--api-request-metering--not-started).
> All depend on Milestone 2; 4.1 also rides on Milestone 1's run wiring.

| # | Task | Notes |
|---|------|-------|
| 4.1 | Compute: `compute_execution` meter on node completion | Duration from existing `started_at`/`completed_at`; `soat`/`compute-second` SKU |
| 4.2 | Storage: daily per-project snapshot job | `gb_day` quantity; idempotency key `storage:{project}:{date}` |
| 4.3 | Requests: counting middleware, flush-aggregated | Never one row per request; enforcement counters stay in [prd-quotas.md](./prd-quotas.md) |

## Milestone 5 — Enforcement & guards (consume the numbers)

> Not metering work itself — the downstream consumers the meters unblock.

| # | Task | Notes |
|---|------|-------|
| 5.1 | Token/cost quotas at the pre-generation check | [Quotas Phase 2](./prd-quotas.md#phase-2--tokencost-quotas-at-the-metering-choke-point--not-started); blocked on Milestone 1–3 aggregates |
| 5.2 | `usage.*` guard context + per-run ceiling | [Metering Phase 7](./prd-usage-metering.md#phase-7--budget-guard-integration-️-deferred), blocked on the [guardrail evaluator](./prd-guardrails.md). Interim: a `condition` node reads the Milestone 1 run roll-up and routes to an abort path |

## Backlog (unsequenced)

- Meter the remaining LLM paths: extraction, discussions, chats
  ([Phase 1 remainder](./prd-usage-metering.md#phase-1--meter-rows--idempotency--done-483))
- Event-driven storage byte accounting (replaces the daily-snapshot
  approximation; see [Risks](./prd-usage-metering.md#risks))

## Dependency graph

```
M1 (run attribution) ──┬─► 4.1 (compute)      ┌─► 5.1 (quotas)
M2 (meter_type) ───────┼─► 4.2 (storage)      │
                       ├─► 4.3 (requests)     │
                       └─► M3 (aggregate) ────┴─► 5.2 (guards, after guardrail evaluator)
```

M1 and M2 are independent of each other and can proceed in parallel; both
land before M3's aggregation endpoint so it groups by `meter_type` and `run`
from day one.
