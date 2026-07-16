# PRD: Usage Metering

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G5).
> Work sequencing lives in the [Usage Roadmap](./usage-roadmap.md).
> Depends on the idempotency keys from
> [prd-orchestration-queue.md](./prd-orchestration-queue.md) for
> exactly-once accounting under retries; feeds the `usage.*` guard context in
> [prd-guardrails.md](./prd-guardrails.md) and the token/cost windows in
> [prd-quotas.md](./prd-quotas.md).

## Implementation Status

| Component                                  | Status                     | Notes                                                                |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------|
| `UsageMeter` model (append-only)           | ✅ Done (#483)              | One row per completed generation; unique idempotency key on the generation |
| Provider-call instrumentation              | 🚧 Agent path (#483, #557)  | Wired for agent generations (non-stream, streaming, and the tool-outputs continuation path, #557), conversations, and orchestration agent nodes; extraction/discussions/chats still pending |
| Reasoning-token breakdown                  | ✅ Done (#483)              | `reasoning_tokens` (and cached) captured from the provider report     |
| `trace_id` attribution                     | ✅ Done (#484)              | Meter links to its trace; filterable                                  |
| Trigger + logical action-id attribution    | ✅ Done (#485, #562)        | `trigger_id`/`action_id` on the meter; in-orchestration-run trigger attribution wired via `OrchestrationRun.trigger_id` (#562) |
| Price book + write-time cost computation   | ✅ Done (#488)              | Cost frozen at write time from the effective price row                |
| Three-tier price resolution                | ✅ Done (#502/#504)         | Per-provider override → project + provider-slug → global default      |
| Default price seeding                      | ❌ Removed (#546)           | SOAT no longer ships default prices; operators load their own. Meters with no matching price row record `cost_usd = null` |
| Per-generation receipt                     | ✅ Done                     | `GET /api/v1/usage/receipt` sums a generation's meters (tokens, cost, price rows used) |
| Run/node attribution (`run_id`, `node_id`) | ✅ Done (#562)              | Threaded through the generation metadata; the run's public id is resolved to its FK at write time, and the idempotency key is scoped by node execution |
| Run roll-up (per-run token/cost sum)       | ✅ Done (#562)              | `GET /api/v1/usage/receipt?run_id=…` per-run receipt + a `usage` object on the orchestration-run response |
| Aggregation endpoint                       | ✅ Done (#564)              | `GET /api/v1/usage` grouped rollups by `model`/`agent`/`run`/`day`/`meter_type` over an optional `[from, to]` window |
| Meter-type generalization                  | ✅ Done                     | Rebuilt as `UsageEvent` (one metered occurrence) + `UsageComponent` (one priced dimension); `PriceBook` prices a SKU component. See [Meter-Type Generalization](#meter-type-generalization) |
| Compute (`compute_execution`) metering        | ❌ Not started              | Duration from existing node timestamps; blocked on run attribution + generalization |
| Storage metering                           | ❌ Not started              | Daily per-project snapshot job                                        |
| API-request metering                       | ❌ Not started              | Flush-aggregated counters; last in sequence                           |
| `usage.threshold_crossed` webhook event    | ✅ Done (#565)              | Fired after each usage-event write when a windowed metric crosses a threshold; once-per-window / 10% re-arm hysteresis |
| Threshold config (`UsageThreshold` table)  | ✅ Done (#565)              | Per-project thresholds + fire state (`UsageThreshold`) + CRUD driving `usage.threshold_crossed` |
| `usage.*` guard context / per-run ceiling  | ⏭️ Deferred                 | Needs the guardrail evaluator ([prd-guardrails.md](./prd-guardrails.md)), which is unbuilt. The run roll-up provides the cumulative signal an interim orchestration `condition` node can read |

## Overview

SOAT meters every agent LLM call into an append-only `UsageEvent` (with its
per-dimension `UsageComponent` rows), priced at write time from a versioned,
three-tier `PriceBook`. Anyone operating
agents per customer project needs to answer "what did this project/run/agent
cost this period" from the platform, and needs the numbers to be
**billing-grade**: append-only, idempotent under retries, priced at write
time.

The write side is deliberately one place — the shared completion side-effects
(`recordGenerationUsage`) — so every provider and every path (agents,
extraction, discussions, orchestration nodes) meters identically, and adding
a provider cannot silently skip metering.

**LLM tokens are not the whole bill.** A project's true cost is
`tokens + infra` — compute time spent executing orchestration nodes, API
requests served, and bytes stored. Today only tokens are metered; the
[Meter-Type Generalization](#meter-type-generalization) section defines how
the same meter/price machinery extends to the other dimensions without a
second metering system.

## Meter-Type Generalization

> **✅ Shipped (Phase 3b) as an event + component model.** The sections below
> capture the original design intent; the delivered realization went further
> than additive columns. A metered occurrence is a `UsageEvent` (attribution +
> total cost) whose measured quantities are `UsageComponent` rows (one priced
> dimension each: `quantity × unit_price`). `PriceBook` prices one component of
> a SKU. Tokens are not privileged — an `llm_tokens` event simply has token
> components. See the [Usage module doc](../packages/website/docs/modules/usage.md)
> for the authoritative field list; where the schema tables below still describe
> `meter_type`/`quantity`/`unit` columns on a single `UsageMeter` row, the
> event + component model supersedes them.

**Decision:** one metering pipeline for all cost dimensions, not one table
per dimension. The attribution chain
(`project → run → node → agent → generation → trace`), the append-only /
idempotency guarantees, the write-time pricing, and the aggregation surface
are identical for every dimension — duplicating them per dimension would
fork billing logic four ways.

### Meter types

| `meter_type`     | What one row records                                        | `quantity` / `unit`        | Emitter (write path)                                                    |
| ---------------- | ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `llm_tokens`     | One completed LLM call's token usage (today's rows)         | `null` — token columns used | `recordGenerationUsage` at generation completion (exists)                |
| `compute_execution` | One orchestration node execution's wall-clock compute time  | seconds / `compute_second`    | Node-completion hook; duration from existing `started_at`/`completed_at` |
| `api_request`    | A batch of API requests served for a project                | requests / `request`       | Counting middleware, aggregated in memory and flushed periodically — **never one row per request** |
| `storage`        | One project's stored bytes for one day                      | GB-days / `gb_day`         | Daily snapshot job summing `File.size` + document/chunk byte counts      |

### Schema changes

**`UsageMeter`** gains:

- `meter_type` VARCHAR NOT NULL DEFAULT `'llm_tokens'` — discriminator; all
  existing rows backfill to `llm_tokens` via the default.
- `quantity` DECIMAL NULL + `unit` VARCHAR NULL — the generic measure for
  non-LLM types. For `llm_tokens` both stay `null`; the token columns remain
  the source of truth (no double-encoding of the same number).
- Token columns (`input_tokens`, `output_tokens`, `cached_tokens`,
  `reasoning_tokens`) are meaningful only for `llm_tokens` and default to `0`
  for other types.
- `generation_id`/`agent_id` are already nullable, so non-LLM rows fit the
  existing attribution model unchanged (`storage` rows carry only
  `project_id`; `compute_execution` rows carry `run_id` + `node_id`).

**`PriceBook`** gains:

- `meter_type` VARCHAR NOT NULL DEFAULT `'llm_tokens'`.
- `unit_price` DECIMAL NULL + `unit` VARCHAR NULL — used when
  `meter_type != 'llm_tokens'`; the per-M token columns stay `null` for those
  rows and vice versa.
- The `(provider, model)` pair generalizes to a **SKU**: for platform meters
  `provider` is `soat` and `model` names the billable unit
  (e.g. `compute-second`, `request`, `gb-day`). This keeps the unique upsert key,
  the three-tier resolution (per-provider override → project + provider-slug
  → global default), the `effective_from` versioning, and the
  past-rows-are-immutable rule working unchanged for every meter type.

**Cost computation** branches on type: `llm_tokens` keeps the existing
token-rate formula; every other type is `quantity × unit_price`. As with
tokens today, a missing price row records the quantity with
`cost_usd = null` — usage is never lost because pricing lagged.

**Decision — USD is the fixed metering currency.** All price and cost
fields are and stay USD-denominated, with the `_usd` suffix in column and
API field names making mixed-currency aggregation unrepresentable. Every
upstream provider quotes in USD, and `SUM(cost_usd)` must never silently
mix currencies. Currency **presentation** (invoicing in BRL/EUR/…) is a
billing concern: the consuming billing layer converts at invoice time with
its own dated FX rate — converting at meter-write time would import an FX
table into metering and, combined with frozen write-time costs, turn every
FX correction into a request to mutate history. Non-USD-priced SKUs, if
they ever appear, are entered in the price book as USD equivalents by the
operator (who owns price data since #546).

### Consumer-facing effects

- `GET /api/v1/usage/meters` gains a `meter_type` filter.
- The receipt and the aggregation endpoint report cost **broken down by
  `meter_type`** plus a grand total — the "tokens + infra" split downstream
  billing needs.
- Thresholds and quotas ([prd-quotas.md](./prd-quotas.md)) keep operating on
  `cost_usd`/`tokens`; a total-cost threshold naturally starts covering infra
  cost once infra meters exist. Request *enforcement* counters
  (`QuotaWindowCounter`) stay separate from request *metering* rows: quotas
  need atomic per-request increments to block, metering needs cheap batched
  rows to bill — different write patterns, deliberately not unified.

## Implementation Phases

Phases 1–2 and 3a–3b are shipped; 3c closes the remaining billing-grade
aggregation gap; 4–6 add the non-LLM dimensions; 7 stays deferred behind
guardrails.

### Phase 1 — Meter Rows + Idempotency ✅ Done (#483)

> Delivered for the agent-completion path (agent generations, conversations,
> orchestration agent nodes), including the tool-outputs continuation path
> (#557). Idempotency is keyed on the generation, and — inside an orchestration
> run — scoped by node execution (`run:<run>:node:<node>`, #562). Reasoning/cached
> token breakdown (#483), `trace_id` (#484), and trigger/action attribution
> (#485) were added on top via epic #482. Extraction, discussions, and chats
> are not yet metered.

**Goal:** Every LLM call produces exactly one attribution-complete usage row —
including under at-least-once redelivery.

**Deliverables:**

- `UsageMeter` model (see [Data Model](#data-model)); **append-only** — no
  update or delete path
- Instrumentation in the shared provider-call wrapper (the single choke point
  all completions already flow through — agent generations, extraction,
  discussions), recording provider, model, input/output/cached tokens, and
  the attribution chain `project → run → node → agent → generation`
- `idempotency_key` unique constraint: the key derives from the generation
  and, inside orchestration runs, from the node idempotency key
  ([prd-orchestration-queue.md](./prd-orchestration-queue.md)) — a replayed
  node upserts into a no-op instead of double counting
- Tenancy tests over the new table

**Unlocks:** Trustworthy raw usage data; the acceptance test "replayed nodes
produce exactly one row per LLM call".

### Phase 2 — Price Book + Cost ✅ Done (#488, #502/#504, #546)

> Meters with no matching price row record `cost_usd = null` and are visible
> through the standard meter list (no separate "missing price" admin view).
> Prices resolve through three tiers — per-provider override
> (`PUT /api/v1/ai-providers/{id}/prices`), project + provider-slug
> (`PUT /api/v1/projects/{id}/prices`), global default
> (`PUT /api/v1/usage/prices`) — most specific wins (#502/#504). Default
> price seeding was shipped and then **removed** (#546): SOAT does not
> maintain a market price list; operators load and own their price data.

**Goal:** Cost in USD computed at write time, immune to later price changes.

**Deliverables:**

- `PriceBook` table: `(provider, model, input/output/cached unit prices,
  effective_from)`; admin CRUD
- `cost_usd` computed at meter-write time from the price row effective at
  that moment — recorded costs never change retroactively when prices update
- Meters with no matching price row record tokens with `cost_usd = null`
  (visible, not lost)

**Unlocks:** Billing-grade cost data downstream consumers can invoice from.
Defining the customer-facing billing unit stays out of scope — SOAT meters,
the consuming product bills.

### Phase 3a — Run/Node Attribution + Run Roll-up ✅ Done

> **Shipped (#562).** `UsageEvent.run_id`/`node_id` are now populated: the
> orchestration run/node (and the run's initiating trigger) are carried on the
> generation metadata and read back at write time, so every generation an
> orchestration node dispatches is attributable to its run. This unblocked
> per-run receipts, the cumulative per-run signal, and in-run trigger
> attribution (#485 remainder).

**Goal:** Every generation started by an orchestration node meters with its
`run_id` + `node_id`; a run exposes the sum of its generations' tokens and
cost.

**Deliverables (all shipped):**

- ✅ Thread the orchestration run/node context through to
  `recordGenerationUsage` (via the generation metadata, the same vehicle as
  `action_id`/`trigger_id`); the run's public id is resolved to its FK at write
  time, and the idempotency key is scoped by node execution
  (`run:<run>:node:<node>`) so a replayed node upserts into a no-op
- ✅ Run roll-up read path: `GET /api/v1/usage/receipt?run_id=…` returning the
  same receipt shape as the per-generation receipt (tokens, cost, price rows,
  per-generation breakdown), summed across the run's meters
- ✅ Surface the roll-up totals on `GET /api/v1/orchestration-runs/{run_id}`
  (`usage` object: total tokens, `cost_usd`); omitted from run list responses
- ✅ In-run trigger attribution: `OrchestrationRun.trigger_id` is set when a
  trigger starts the run and propagated onto every in-run generation's event

**Unlocks:** Per-run receipts ("one operating cycle → one action" billing),
the cumulative per-run signal for a ceiling check, correct in-run
trigger/action attribution.

### Phase 3b — Meter-Type Generalization (schema) ✅ Done

**Goal:** The meter and price schemas carry a `meter_type` so non-LLM
dimensions land in the same pipeline — done **before** billing consumers
(PRD-002 credits) freeze on the current shape.

**Shipped as a ground-up redesign, not additive columns.** Rather than
privileging tokens on `UsageMeter`, metering was rebuilt into a uniform
event + component model so no meter type is special (the old `UsageMeter`
table was dropped).

**Deliverables:**

- `UsageEvent` (`ue_`): one metered occurrence — attribution chain
  (`project`/`run`/`node`/`agent`/`generation`/`trace`/`ai_provider`/
  `trigger`/`action`), `meter_type`, SKU (`provider`/`model`), total
  `cost_usd`; append-only, idempotent on the generation. `meter_type` filter
  on `GET /api/v1/usage/meters`.
- `UsageComponent` (`uc_`): one priced dimension per row — `component`,
  `quantity`, `unit`, `billable`, `unit_price`, `cost_usd`, `price_id`. An
  `llm_tokens` event has `input_tokens`/`output_tokens`/`cached_tokens` (+ a
  non-billable `reasoning_tokens` detail); `compute_execution` a single
  `compute_second`.
- `PriceBook`: prices **one component of a SKU** per row
  (`meter_type`, `provider`, `model`, `component`, `unit`, `unit_price`,
  `effective_from`); three-tier resolution and future-dated immutability
  unchanged; per-component upsert validation.
- Cost is uniform `quantity × unit_price` per component; the event's
  `cost_usd` is the sum. Token components are priced per token.
- Receipt gains a `by_meter_type` cost split and reconstructed token totals
  (single-type receipts unchanged in their totals).

**Unlocks:** Phases 4–6 become emitter-only work; the "tokens + infra" split
of the receipt.

### Phase 3c — Aggregation + Events ✅ Done

> **Shipped (#564, #565).** The grouped aggregation endpoint, the
> `UsageThreshold` table + CRUD, and the `usage.threshold_crossed` webhook all
> landed on top of the existing raw meter list.

**Goal:** Usage is queryable and pushable, not just stored — a per-project
monthly cost figure without scanning every meter row client-side.

**Deliverables:**

- ✅ `GET /api/v1/usage?project_id&from&to&group_by=model|agent|run|day|meter_type`
  returning token and cost rollups (SUM over the indexed
  `(project_id, created_at)` meter rows) (#564)
- ✅ `UsageThreshold` table + CRUD endpoints (see
  [Usage Thresholds](#usage-thresholds)) — per-project thresholds on cost or
  tokens over a calendar-month or rolling-24h window (#565)
- ✅ Webhook event `usage.threshold_crossed` — fired when a project's
  cost/tokens in the configured window crosses a configured threshold, with
  the once-per-window / hysteresis re-fire rules defined in
  [Usage Thresholds](#usage-thresholds); evaluated synchronously after each
  usage-event write (#565)

**Unlocks:** Unit-economics reporting per project/cycle/role and proactive
budget alerts without polling; the monthly per-project figure billing
reconciles against.

### Phase 4 — Compute Metering (`compute_execution`) ❌ Not started

**Depends on Phases 3a + 3b.** Rides on the same run/node wiring: the
node-completion hook that stamps `completed_at` writes one `compute_execution`
meter row (`quantity` = wall-clock seconds from the execution's own
timestamps, `run_id`/`node_id` attribution, idempotency key from the node
execution). Priced via a `soat`/`compute-second` SKU when the operator defines
one; `cost_usd = null` otherwise.

**Unlocks:** The compute half of "tokens + infra"; per-run receipts that
include execution time.

### Phase 5 — Storage Metering ❌ Not started

**Depends on Phase 3b.** A daily snapshot job writes one `storage` meter row
per project (`quantity` = GB-days: total bytes across `File.size` plus
document/chunk content, sampled once per UTC day; idempotency key
`storage:{project_id}:{YYYY-MM-DD}` so a re-run job cannot double-count).
Priced via a `soat`/`gb-day` SKU.

**Unlocks:** The storage line of the project bill; "which project's knowledge
base is costing us" visibility.

### Phase 6 — API-Request Metering ❌ Not started

**Depends on Phase 3b. Deliberately last** — least dollar-material and the
only dimension needing new infrastructure. A counting middleware aggregates
requests in memory per `(project, api_key)` and flushes one `api_request`
meter row per counter per flush interval (`quantity` = request count;
idempotency key from the flush window). One row **per request** is explicitly
rejected — it would multiply every agent tool loop into meter writes.
Enforcement stays with [prd-quotas.md](./prd-quotas.md)'s atomic counters;
this phase only prices.

**Unlocks:** The request line of the project bill.

### Phase 7 — Budget Guard Integration ⏭️ Deferred

> Blocked on the guardrail evaluator and `usage.*` guard context
> ([prd-guardrails.md](./prd-guardrails.md)), which are unbuilt. The per-run
> token-ceiling issue (#486) was deferred for the same reason. Interim: now that
> Phase 3a has landed, an orchestration `condition` node can read the run's
> cumulative usage (via the run roll-up) and route to an abort path —
> a modelable pattern, not a platform guarantee.

**Goal:** Runaway cycles trip fail-closed like any other guard.

**Deliverables:**

- `usage.*` context provider for the
  [guardrail evaluator](./prd-guardrails.md):
  `usage.cost_usd(window)`, `usage.tokens(window)`, per project
- Documented pattern: a class-B rule guarded by
  `{'<': [{var: 'usage.cost_usd_24h'}, {var: 'project.context.cost_ceiling'}]}`
  aborts (tripwire → exception) when the ceiling is hit

**Unlocks:** Hard per-project spend ceilings enforced deterministically at the
tool boundary.

## Usage Thresholds

**Decision:** thresholds live in a dedicated `UsageThreshold` table, not a
JSONB field on `Project` — each threshold carries mutable fire state
(`last_fired_at`, `fired_window_key`) that the hysteresis rules depend on,
and mixing per-row state machines into an unvalidated JSONB blob would make
the once-per-window guarantee unenforceable at the DB level.

A project can have multiple thresholds (e.g. a 50 USD warning and a 100 USD
alert). Each threshold is defined by:

- `metric` — `cost_usd` | `tokens` (tokens = input + output + cached).
  `cost_usd` aggregates across **all meter types**, so infra meters count
  toward a cost threshold as soon as they exist.
- `window` — explicit, one of:
  - `calendar_month` — the current UTC calendar month; resets at
    00:00 UTC on the 1st. The window key is `YYYY-MM` (e.g. `2026-07`).
  - `rolling_24h` — the trailing 24 hours, evaluated at each meter write.
- `threshold` — the numeric value the windowed aggregate must cross.

Evaluation happens synchronously after each `UsageMeter` write (the write is
already the single choke point), comparing the windowed aggregate against
every threshold on the meter's project.

**Re-fire rules (hysteresis):**

- `calendar_month` — fires **at most once per threshold per window**: on
  firing, `fired_window_key` is set to the current window key; the threshold
  cannot fire again until the key changes (i.e. resets at the window
  boundary). Usage in a calendar window only grows (meters are append-only),
  so no hysteresis band is needed.
- `rolling_24h` — the windowed value can fall as old meters age out, so a
  fired threshold **re-arms only when the value drops below 90% of the
  threshold** (10% hysteresis band); it may then fire again on the next
  crossing. This prevents flapping when usage hovers at the threshold.
- Deleting and recreating a threshold resets its fire state.

Webhook payload (snake_case, standard webhook envelope):

```json
{
  "type": "usage.threshold_crossed",
  "data": {
    "threshold_id": "uthr_V1StGXR8Z5jdHi6B",
    "project_id": "proj_V1StGXR8Z5jdHi6B",
    "metric": "cost_usd",
    "window": "calendar_month",
    "window_key": "2026-07",
    "threshold": 100,
    "observed_value": 101.37
  }
}
```

(`window_key` is `null` for `rolling_24h`.)

Configuration endpoints (see [REST API](#rest-api)):
`GET /api/v1/usage/thresholds?project_id=…`,
`POST /api/v1/usage/thresholds`,
`DELETE /api/v1/usage/thresholds/{threshold_id}`. Thresholds are immutable
apart from deletion — replace by delete + create, which keeps the fire-state
semantics trivial.

## Data Model

### UsageMeter

Columns marked **(3b)** are added by the generalization phase.

| Column          | Type         | Constraints                                        |
| --------------- | ------------ | --------------------------------------------------- |
| id              | INTEGER      | PK                                                  |
| publicId        | VARCHAR(32)  | UNIQUE, `um_` prefix                                |
| projectId       | INTEGER      | FK → Project, NOT NULL                              |
| runId           | INTEGER      | FK → OrchestrationRun, NULL (populated for in-run generations, #562) |
| nodeId          | VARCHAR      | NULL (node within the run; populated for in-run generations, #562)   |
| agentId         | INTEGER      | FK → Agent, NULL                                    |
| generationId    | INTEGER      | FK → Generation, NULL                               |
| traceId         | INTEGER      | FK → Trace, NULL                                    |
| aiProviderId    | INTEGER      | FK → AiProvider, NULL                               |
| triggerId       | VARCHAR      | NULL; initiating trigger's public id                |
| actionId        | VARCHAR      | NULL; caller-supplied logical action id (from `generation.metadata`) |
| meterType       | VARCHAR      | **(3b)** NOT NULL DEFAULT `llm_tokens`; `llm_tokens` \| `compute_execution` \| `api_request` \| `storage` |
| provider        | VARCHAR      | NOT NULL (`soat` for platform meter types)          |
| model           | VARCHAR      | NOT NULL (the SKU for platform meter types)         |
| inputTokens     | INTEGER      | NOT NULL (`llm_tokens` only; 0 otherwise)           |
| outputTokens    | INTEGER      | NOT NULL (`llm_tokens` only; 0 otherwise)           |
| cachedTokens    | INTEGER      | NOT NULL DEFAULT 0                                  |
| reasoningTokens | INTEGER      | NOT NULL DEFAULT 0                                  |
| quantity        | DECIMAL      | **(3b)** NULL; the measure for non-LLM types        |
| unit            | VARCHAR      | **(3b)** NULL; `compute_second` \| `request` \| `gb_day` |
| costUsd         | DECIMAL      | NULL when no price row matched                      |
| priceId         | INTEGER      | FK → PriceBook, NULL; the price row applied         |
| idempotencyKey  | VARCHAR      | UNIQUE, NOT NULL                                    |
| createdAt       | TIMESTAMP    | NOT NULL; no updatedAt — rows are immutable         |

Indexes: `(projectId, createdAt)`, `(runId)`, `(traceId)`, unique
`(idempotencyKey)`.

### PriceBook

Columns marked **(3b)** are added by the generalization phase.

| Column          | Type         | Constraints                          |
| --------------- | ------------ | ------------------------------------ |
| id              | INTEGER      | PK                                   |
| publicId        | VARCHAR(32)  | UNIQUE, `price_` prefix (registered in `packages/postgresdb/src/utils/publicId.ts`) |
| aiProviderId    | INTEGER      | FK → AiProvider, NULL; set on per-provider override rows (tier 1) |
| projectId       | INTEGER      | FK → Project, NULL; set on project + provider-slug rows (tier 2); both NULL = global default (tier 3) |
| meterType       | VARCHAR      | **(3b)** NOT NULL DEFAULT `llm_tokens` |
| provider        | VARCHAR      | NOT NULL (`soat` for platform SKUs)  |
| model           | VARCHAR      | NOT NULL (the SKU for platform meter types) |
| inputPricePerM  | DECIMAL      | USD per million input tokens; NULL on non-LLM rows |
| outputPricePerM | DECIMAL      | USD per million output tokens; NULL on non-LLM rows |
| cachedPricePerM | DECIMAL      | NULL → falls back to input price     |
| unitPrice       | DECIMAL      | **(3b)** NULL; USD per `unit` on non-LLM rows |
| unit            | VARCHAR      | **(3b)** NULL; must match the meter's unit |
| effectiveFrom   | TIMESTAMP    | NOT NULL; latest row ≤ now() applies |
| createdAt       | TIMESTAMP    | NOT NULL; append-only — no updatedAt |

Unique index: `(aiProviderId, projectId, provider, model, effectiveFrom)` —
the upsert key (see [Price book upsert](#price-book-upsert)). Resolution is
most-specific-first: per-provider override → project + provider-slug →
global default.

### UsageThreshold

| Column         | Type         | Constraints                                            |
| -------------- | ------------ | ------------------------------------------------------- |
| id             | INTEGER      | PK                                                      |
| publicId       | VARCHAR(32)  | UNIQUE, `uthr_` prefix (registered in `packages/postgresdb/src/utils/publicId.ts`) |
| projectId      | INTEGER      | FK → Project, NOT NULL                                  |
| metric         | VARCHAR      | NOT NULL; `cost_usd` \| `tokens`                        |
| window         | VARCHAR      | NOT NULL; `calendar_month` \| `rolling_24h`             |
| threshold      | DECIMAL      | NOT NULL, > 0                                           |
| lastFiredAt    | TIMESTAMP    | NULL until first fire                                   |
| firedWindowKey | VARCHAR      | NULL; `YYYY-MM` key for `calendar_month` hysteresis     |
| createdAt      | TIMESTAMP    | NOT NULL                                                |

Index: `(projectId)`. Fire-state semantics are defined in
[Usage Thresholds](#usage-thresholds).

## Permissions

| Permission                | Endpoint                                            | Status |
| ------------------------- | ---------------------------------------------------- | ------ |
| `usage:ListUsageMeters`   | `GET /api/v1/usage/meters`                           | ✅     |
| `usage:GetReceipt`        | `GET /api/v1/usage/receipt`                          | ✅     |
| `usage:GetPriceBook`      | `GET /api/v1/usage/prices`                           | ✅     |
| `usage:ManagePriceBook`   | `PUT /api/v1/usage/prices` (admin)                   | ✅     |
| `usage:GetUsage`          | `GET /api/v1/usage`                                  | ✅     |
| `usage:ListThresholds`    | `GET /api/v1/usage/thresholds`                       | ✅     |
| `usage:ManageThresholds`  | `POST /api/v1/usage/thresholds`, `DELETE /api/v1/usage/thresholds/{threshold_id}` | ✅     |

Actions are defined in `packages/server/src/permissions/usage.json`.
Per-provider and per-project price endpoints carry their own module
permissions (`ai-providers`, `projects`).

## REST API

| Method | Path                                       | Description                                             | Status |
| ------ | ------------------------------------------ | ------------------------------------------------------- | ------ |
| GET    | `/api/v1/usage/meters`                     | Raw meter rows, cursor-paginated (audit/reconciliation); filters: agent, generation, trace, trigger, action (+ `meter_type` after 3b) | ✅ |
| GET    | `/api/v1/usage/receipt`                    | Per-generation receipt (`generation_id`); per-run receipt (`run_id`, #562) | ✅ |
| GET    | `/api/v1/usage/prices`                     | Global default price book                                | ✅ |
| PUT    | `/api/v1/usage/prices`                     | Upsert global price rows (admin)                         | ✅ |
| GET/PUT | `/api/v1/ai-providers/{id}/prices`        | Per-provider price overrides (tier 1)                    | ✅ |
| GET/PUT | `/api/v1/projects/{id}/prices`            | Project + provider-slug prices (tier 2)                  | ✅ |
| GET    | `/api/v1/usage`                            | Aggregated usage (`project_id`, `from`, `to`, `group_by=model\|agent\|run\|day\|meter_type`) | ✅ |
| GET    | `/api/v1/usage/thresholds`                 | List thresholds (`project_id` filter)                     | ✅ |
| POST   | `/api/v1/usage/thresholds`                 | Create a threshold                                        | ✅ |
| DELETE | `/api/v1/usage/thresholds/{threshold_id}`  | Delete a threshold (resets its fire state)                | ✅ |

### Price book upsert

`PUT /api/v1/usage/prices` takes a batch of rows keyed on
`(provider, model, effective_from)`.

**Decision:** rows whose `effective_from` is already in the past are
immutable — upserting onto a past-effective key returns `400`. Recorded
`cost_usd` values are frozen at write time, so allowing historical price
edits would make the price book disagree with the costs it supposedly
explains; corrections ship as new future-dated rows.

Request:

```json
{
  "prices": [
    {
      "provider": "openai",
      "model": "gpt-4o",
      "input_price_per_m": 2.5,
      "output_price_per_m": 10.0,
      "cached_price_per_m": 1.25,
      "effective_from": "2026-08-01T00:00:00Z"
    }
  ]
}
```

After Phase 3b, platform SKUs use the unit-price shape instead:

```json
{
  "prices": [
    {
      "meter_type": "compute_execution",
      "provider": "soat",
      "model": "compute-second",
      "unit_price": 0.0001,
      "unit": "compute_second",
      "effective_from": "2026-08-01T00:00:00Z"
    }
  ]
}
```

Response (`200`; each row carries its public ID):

```json
{
  "prices": [
    {
      "id": "price_V1StGXR8Z5jdHi6B",
      "provider": "openai",
      "model": "gpt-4o",
      "input_price_per_m": 2.5,
      "output_price_per_m": 10.0,
      "cached_price_per_m": 1.25,
      "effective_from": "2026-08-01T00:00:00Z",
      "created_at": "2026-07-07T12:00:00Z"
    }
  ]
}
```

A row matching an existing future-dated `(provider, model, effective_from)`
key replaces that row's prices; otherwise a new row is inserted.

## Risks

- **Schema generalization after billing freezes on the current shape** —
  PRD-002 (credits) consumes meters; adding `meter_type` after invoicing
  logic hardcodes "a meter row is tokens" forks billing. Mitigation: Phase 3b
  is sequenced before any billing consumer, and defaults make it a purely
  additive migration.
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
  missing-token-price behavior — quantities are still recorded and priceable
  retroactively is **not** offered (write-time pricing is the invariant), so
  operators should define SKUs before enabling infra billing.
