---
description: "Usage events record the cost of every metered occurrence — a completed LLM call, an orchestration node's compute, API requests, and stored bytes — attributed to a project, agent, and generation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Usage

Usage events record the cost of every metered occurrence, with the measured quantities held in per-dimension component rows, so spend can be attributed to a project, agent, and generation.

## Overview

Whenever SOAT completes an LLM call, it records one **usage event** plus its **component** rows. An event captures the attribution and total cost; each component captures one priced dimension — for an LLM call `input_tokens`, `output_tokens`, `cached_tokens` (and a non-billable `reasoning_tokens` detail). No meter type is privileged: `llm_tokens` is just an event with several components, and other dimensions are the same shape with different components — `compute_execution` (one event per orchestration node execution), `storage` (a daily per-project snapshot), and `api_request` (flush-aggregated request counts) are all metered today. Every LLM path is covered — agent generations plus the standalone chat, discussion, and memory completions (see [Coverage](#coverage)) — and each writes through a shared choke point, so adding a provider cannot silently skip metering.

Events and components are **append-only and immutable** — no update or delete path, no `updated_at` — so historical usage never changes after the fact. Writes are **idempotent** on the generation's public ID: a replayed completion is a no-op instead of double counting.

Every event links back to the resources it attributes spend to: the [generation](./generations.md) that produced the call and its [agent](./agents.md), the [trace](./traces.md) it belongs to, the [AI provider](./ai-providers.md) instance billed, the [project](./projects.md) it rolls up to, and — when applicable — the [trigger](./triggers.md) or [orchestration](./orchestrations.md) run that initiated it.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Cap Spend Per End User - Step 6 (Read spend per end user)](/docs/tutorials/cap-spend-per-end-user#step-6--read-spend-per-end-user)
- [Meter and Budget Your Project's Spend - Step 4 (Inspect the raw usage meter)](/docs/tutorials/metering-and-budgets#step-4--inspect-the-raw-usage-meter)

## Data Model

### UsageEvent

| Field            | Type            | Description                                                                                  |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `id`             | string          | Public identifier for the usage event (`ue_` prefix)                                         |
| `project_id`     | string          | Project the usage is attributed to                                                           |
| `orchestration_run_id`         | string \| null  | Orchestration run that initiated the occurrence, when it ran inside a run                    |
| `node_id`        | string \| null  | Orchestration node within the run, when applicable                                           |
| `agent_id`       | string \| null  | Agent that ran the generation                                                                |
| `generation_id`  | string \| null  | Generation this usage was recorded for                                                       |
| `trace_id`       | string \| null  | Trace this usage belongs to (reconcile against the trace tree)                               |
| `actor_id`       | string \| null  | Actor (end user) the occurrence was produced for; `null` when no end user is behind the work |
| `session_id`     | string \| null  | Session the occurrence ran in; `null` when not dispatched through a session                  |
| `ai_provider_id` | string \| null  | AI provider instance billed; correlates the event to the price book                          |
| `trigger_id`     | string \| null  | Trigger that initiated the generation (agent-target triggers); null otherwise                |
| `action_id`      | string \| null  | Caller-supplied logical action label, for rolling spend up per action                        |
| `source`         | string \| null  | The workload behind the spend when it is not ordinary agent traffic; see [Workload source](#workload-source) |
| `meter_type`     | string          | What the event measures: `llm_tokens`, `compute_execution`, `api_request`, or `storage`         |
| `provider`       | string          | As-billed SKU vendor slug (e.g. `openai`); `soat` for platform meter types                   |
| `model`          | string          | Model identifier the provider billed; the billable SKU for platform meter types              |
| `cost_usd`       | number \| null  | Total cost in USD — the sum of the priced component costs, frozen at write time; `null` when nothing is priced |
| `components`     | array           | The priced dimensions of this event (see UsageComponent)                                     |
| `created_at`     | string          | ISO 8601 creation timestamp                                                                  |

### UsageComponent

One priced dimension of an event. Every meter type is expressed as components, so tokens and infra are uniform: `quantity` is always in `unit`, and `cost_usd = quantity × unit_price`.

| Field        | Type            | Description                                                                                   |
| ------------ | --------------- | --------------------------------------------------------------------------------------------- |
| `component`  | string          | The measured dimension: `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `compute_second`, `request`, `gb_day`, … |
| `quantity`   | number          | The measured amount, expressed in `unit`                                                      |
| `unit`       | string          | Unit `quantity` is measured in (`token`, `compute_second`, `request`, `gb_day`)                  |
| `billable`   | boolean         | Whether the component contributes to cost. `reasoning_tokens` (a subset of `output_tokens`) is non-billable and excluded from cost and billable totals |
| `unit_price` | number \| null  | USD per `unit`, frozen at write time; `null` when unpriced                                    |
| `cost_usd`   | number \| null  | `quantity × unit_price`, frozen at write time; `null` when unpriced                           |
| `price_id`   | string \| null  | Price-book row that produced `unit_price`/`cost_usd`; `null` when unpriced                     |

### PriceBook

A versioned unit price for one billable **component** of a SKU: cost is uniform across meter types (`quantity × unit_price`). Three scopes live in one table, resolved most-specific first. A **per-provider override** (`ai_provider_id` set) prices one specific [AI provider](./ai-providers.md) instance — e.g. an enterprise-negotiated rate or a gateway with markup. A **project + provider-slug** price (`project_id` set, `ai_provider_id` null) covers every one of a [project](./projects.md)'s instances of a slug. A **global default** (both null). Cost lookup prefers instance → project+slug → global; within each scope the latest `effective_from <= now()` applies.

| Field            | Type            | Description                                                        |
| ---------------- | --------------- | ------------------------------------------------------------------ |
| `id`             | string          | Public identifier for the price row (`price_` prefix)              |
| `ai_provider_id` | string \| null  | Set for a per-provider override; `null` otherwise                   |
| `project_id`     | string \| null  | Set for a project + provider-slug price; `null` otherwise           |
| `meter_type`     | string          | Meter type this SKU belongs to (`llm_tokens`, `compute_execution`, …) |
| `provider`       | string          | SKU vendor slug (e.g. `openai`); `soat` for platform SKUs          |
| `model`          | string          | Model identifier, or the billable SKU for platform meter types    |
| `component`      | string          | The component this row prices (`input_tokens`, `compute_second`, …)   |
| `unit`           | string          | Unit `unit_price` is denominated in (`token`, `compute_second`, …)   |
| `unit_price`     | number          | USD per `unit` (for token components, USD per token)               |
| `effective_from` | string          | ISO 8601; the latest row `<= now()` prices a call                  |
| `created_at`     | string          | ISO 8601 creation timestamp                                        |

### UsageThreshold

A per-project alert rule on windowed usage. When the project's `metric` over `window` crosses `threshold`, a `usage.threshold_crossed` [webhook](./webhooks.md) fires. Thresholds are immutable apart from deletion — to change one, delete and recreate it (which resets its fire state).

| Field              | Type            | Description                                                                       |
| ------------------ | --------------- | -------------------------------------------------------------------------------- |
| `id`               | string          | Public identifier for the threshold (`uthr_` prefix)                              |
| `project_id`       | string          | Project the threshold applies to                                                 |
| `metric`           | string          | `cost_usd` (across all meter types) or `tokens` (input + output + cached)         |
| `window`           | string          | `calendar_month` (current UTC month) or `rolling_24h` (trailing 24 hours)        |
| `threshold`        | number          | The value the windowed aggregate must cross to fire (`> 0`)                       |
| `last_fired_at`    | string \| null  | When it last fired; `null` until the first fire                                   |
| `fired_window_key` | string \| null  | `YYYY-MM` key of the last fire (`calendar_month` hysteresis); `null` for `rolling_24h` |
| `created_at`       | string          | ISO 8601 creation timestamp                                                       |

## Key Concepts

### Meter types and components

Every event carries a `meter_type`, and its measured quantities live in component rows, so cost dimensions beyond LLM tokens share one metering pipeline (attribution chain, append-only/idempotency guarantees, write-time pricing, aggregation) rather than forking a table per dimension.

| `meter_type`     | What one event records                              | Components                                        |
| ---------------- | --------------------------------------------------- | ------------------------------------------------- |
| `llm_tokens`     | One completed LLM call's token usage (today's events) | `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens` |
| `compute_execution` | Wall-clock compute time of a unit of work (orchestration node, agent generation, tool call) | `compute_second`                                     |
| `api_request`    | A batch of API requests served for a project        | `request`                                         |
| `storage`        | One project's stored bytes for one day              | `gb_day`                                          |

For platform meter types the `(provider, model)` pair is a **SKU**: `provider` is `soat` and `model` names the billable unit (e.g. `compute-second`, `gb-day`, `request`). The `compute_execution`, `storage`, and `api_request` emitters are all live (see [Coverage](#coverage)).

### Token components

An LLM event's tokens are split into disjoint, additive components. `input_tokens` is the **uncached** input (cached tokens are billed separately at their own rate), so full prompt tokens = `input_tokens` + `cached_tokens`. `reasoning_tokens` is a **non-billable** detail — a subset of `output_tokens` reported for visibility, never priced and never double-counted. Cached and reasoning components are recorded only when the provider reports them.

### Coverage

**Every LLM call the platform makes is metered.** There are two write paths, and both produce the same `llm_tokens` event with the same components and pricing:

| Path | Metered calls | Event attribution |
| --- | --- | --- |
| Agent generations | Agent generate (non-streaming, streaming, and the tool-outputs continuation), [conversations](./conversations.md), and [orchestration](./orchestrations.md) agent nodes — all run through the same agent-completion path | Full chain: `generation_id`, `agent_id`, `trace_id`, plus `orchestration_run_id`/`node_id` inside a run |
| Standalone completions | [Chat](./chats.md) completions (stateless and chat-scoped, streaming and not), [discussion](./discussions.md) turns, and [memory](./memories.md) fact extraction and consolidation | `generation_id` and `trace_id` are always `null` — these calls create no generation. `agent_id` is set for memory extraction/consolidation (which are anchored to an agent) and `null` for chats and discussions |

When a generation runs inside an orchestration [run](./orchestrations.md), its event carries the `orchestration_run_id` and `node_id` of the dispatching node; both are `null` for standalone generations. For events recorded inside a run, the idempotency key is scoped to the node execution (`run:<orchestration_run_id>:node:<node_id>`), so a replayed node upserts into a no-op instead of double counting.

Standalone completions have no replay identity — nothing re-delivers them, and a retried request is a new provider call that must be billed — so their idempotency key is unique per call (`completion:<source>:<uuid>`, where `source` is `chat`, `discussion`, `memory_extraction`, or `memory_consolidation`).

A **streamed** completion is metered when the stream finishes, since token counts only arrive with the provider's final chunk. A stream the client abandons mid-way is therefore not metered.

### Compute metering

Every [orchestration](./orchestrations.md) node execution that actively ran writes one `compute_execution` event alongside any token metering, carrying a single `compute_second` component whose `quantity` is the node's wall-clock seconds (`completed_at − started_at`). This is independent of LLM tokens, so a non-agent node (a `transform`, `condition`, or `tool` node) still meters compute, and an agent node produces both an `llm_tokens` event and a `compute_execution` event. Compute is attributed at the run/node level (`orchestration_run_id` + `node_id`); `generation_id`, `agent_id`, and `trace_id` are `null`. It is priced from a `soat`/`compute-second` price-book SKU when one is effective (`cost_usd = null` otherwise), and the event is idempotent on the node execution (`compute:<orchestration_run_id>:node:<node_id>:attempt:<n>`) so a redelivered node is never double-counted. A skipped node (which never ran) is not metered.

### Storage metering

A daily snapshot writes one `storage` event per project for each UTC day, carrying a single `gb_day` component whose `quantity` is the project's stored gigabytes (total bytes ÷ 1e9). Stored bytes = uploaded [file](./files.md) sizes plus the [document](./documents.md) chunk text held for retrieval, summed at snapshot time. The event has no principal/agent/run attribution (`generation_id`, `agent_id`, `orchestration_run_id`, `trace_id` are `null`), is priced from a `soat`/`gb-day` SKU when one is effective (`cost_usd = null` otherwise), and is idempotent on `storage:<project>:<YYYY-MM-DD>` — a re-run for the same day is a no-op. The daily sample misses intra-day churn (a project that uploads and deletes between samples meters zero for that span); this is accepted for v1, bounded by the sampling interval and symmetric across projects.

### API-request metering

Each served API request is counted in memory per (project, API key), and a periodic flush writes one `api_request` event per counter per window, carrying a single `request` component whose `quantity` is the count. It is deliberately **never one row per request** — that would turn every agent tool loop into meter writes. Counting scope mirrors [quotas](./quotas.md#which-project-a-request-counts-against) exactly, including how a request is attributed to a project: only API-key-authenticated requests are counted (JWT-user requests are not, and neither are the [background self-calls](./quotas.md#which-project-a-request-counts-against) a run-as token makes), a project-scoped key counts against its bound project, and an **unscoped** key counts against the project the route resolved and authorized — never against one the caller was denied, and never more than once per request. A request that resolves to no single project is not counted. Enforcement stays with quotas — this only prices. Priced from a `soat`/`request` SKU (`cost_usd = null` otherwise). The flush-window idempotency key includes a per-instance id, so multiple server instances each record their own window row rather than colliding; the last still-open window is lost on an unclean shutdown (a bounded, symmetric undercount).

### Trigger and action attribution

`action_id` is a caller-supplied label passed on the generate request (`action_id`), persisted on the [generation](./generations.md) and copied onto its event so spend can be rolled up per logical action independent of the agent or generation. `trigger_id` is set automatically when a [trigger](./triggers.md) initiates the generation — both for a direct **agent-target** trigger and for generations produced inside an [orchestration](./orchestrations.md) run started by a trigger (the run carries the trigger id and propagates it to every in-run generation). Filter the event list by either (`?trigger_id=` / `?action_id=`) to roll usage up by trigger or action.

### Workload source

`source` names the workload that produced the spend, so verification and background work are
separable from the traffic serving real users.

| `source` | What produced the event |
| --- | --- |
| `null` | An ordinary agent generation — already identified by `generation_id` / `agent_id` |
| `eval` | An [eval run](./evaluations.md#eval-spend-is-separable-from-production-spend)'s item generations |
| `eval_judge` | An `llm_judge` scorer's own grading completion |
| `chat` | A standalone [chat](./chats.md) completion |
| `discussion` | A [discussion](./discussions.md) turn |
| `memory_extraction` / `memory_consolidation` | A [memory](./memories.md) pass |

Verification spend is `source IN ('eval','eval_judge')` — and the two are kept distinct so a
rollup can price *running* a suite apart from *grading* it, since a judge doubles the calls.
Like every other dimension, `source` is set by the platform at the metering choke point and
copied from the generation's own column, so a caller cannot bill eval spend as production or
the reverse.

### End-user attribution

An event carries the [actor](./actors.md) and [session](./sessions.md) it was produced for, so spend can be answered per end user rather than only per agent. Both are copied from the generation at write time and **frozen** there, the same rule as `cost_usd`: renaming an actor, closing a session, or deleting either never rewrites recorded spend — the row survives with a `null` dimension instead of vanishing from the project's totals.

Attribution is set on the [session](./sessions.md) path, which is the surface that knows which end user a turn belongs to — including the continuation a client-tool approval re-handoff produces, so an approved tool call stays billed to the same end user. Direct agent generations, [trigger](./triggers.md)-initiated work, and [orchestration](./orchestrations.md) nodes have no end user behind them and record `null` for both, as do the standalone completions in [Coverage](#coverage) — a chat, discussion, or memory pass is not dispatched through a session.

The actor is **derived from the session**, never taken from the request: the session already owns its actor link, so an event can never be billed to one actor under another's session, and a caller cannot bill someone else by overriding `tool_context` (that bag is caller-writable and is not read for attribution).

Both dimensions filter (`GET /api/v1/usage/meters?actor_id=…` / `?session_id=…`) and group (`group_by=actor` / `group_by=session`). Because the values are written, not backfilled, events recorded before this shipped carry `null` — historical spend cannot be re-attributed after the fact.

### Pricing

Each component's cost is computed at write time from the effective price row for its `(provider, model, component)`, resolved most-specific first: the AI provider instance → the project's rate for that slug → the global default. The event's `cost_usd` is the sum of its component costs. Costs are frozen onto the components, so later price changes never alter them — swapping a model changes new-run cost while historical receipts stay put. `cached_tokens` falls back to the `input_tokens` rate when no cached price is set (no cache discount). A component's `cost_usd` is `null` only when no price row covers it — the quantity is still captured, it does not mean the call was free.

Token components are priced **per token** (`unit` = `token`, `unit_price` in USD per token). Price rows require `component`, `unit`, and a non-negative `unit_price`; a malformed row is rejected with `400`.

Each component records `price_id` — the exact price-book row that produced its cost. Because cost is frozen and the price row is versioned, a receipt is auditable to the precise price applied even after prices change.

SOAT ships **no default prices** — until an operator adds a price row, cost is `null` (the quantity is still captured) rather than an indicative, potentially stale rate. Prices are managed where their scope lives:

- **Global defaults** — admins via `PUT /api/v1/usage/prices`. `GET /api/v1/usage/prices` lists only these, so no project sees another's rates.
- **Project + provider-slug** — project members via [`PUT /api/v1/projects/{project_id}/prices`](./projects.md), pricing all of a project's instances of a slug at once.
- **Per-provider override** — project members via [`PUT /api/v1/ai-providers/{ai_provider_id}/prices`](./ai-providers.md#price-overrides), pricing one instance.

Past-effective prices are immutable — corrections ship as new future-dated rows.

Prices can also be **declared in a formation** with the `project_price` resource type, so a deployed stack produces billing-grade cost with no out-of-band pricing step. Each `project_price` upserts one project + provider-slug row keyed on `(provider, model, component, effective_from)`. Unlike the REST paths, `effective_from` is optional and defaults to deploy time — the price is live immediately for generations run right after deploy — and the formation owns the row declaratively (updates mutate it in place; already-recorded costs keep their frozen snapshot). See [Formations Types → Project Price](/docs/formations-types/project-price).

### Receipts and reconciliation

`GET /api/v1/usage/receipt?generation_id=…` returns a billing **receipt** for a completed generation: one line item per usage event (its SKU, cost, and component breakdown), a `by_meter_type` cost split (the "tokens + infra" split — one entry per distinct meter type), reconstructed token totals (`total_input_tokens` is uncached input + cached), plus a grand total. A single-type receipt has one `by_meter_type` entry whose cost equals the receipt total. Because every component carries the exact price-book version and the cost is frozen at write time, receipts stay reproducible and are meant to reconcile against the provider's invoice within a small tolerance (target ±2%); investigate any project whose summed receipts drift beyond it.

`GET /api/v1/usage/receipt?orchestration_run_id=…` returns the same receipt shape for an entire [orchestration](./orchestrations.md) run — "one operating cycle → one action" billing — with one line item per usage event across every node of the run, summed for the totals and the `by_meter_type` split. The response carries `orchestration_run_id` (and omits `generation_id`). The run's token/cost roll-up is also surfaced inline on the run itself as a `usage` object on `GET /api/v1/orchestration-runs/{orchestration_run_id}`, so callers see run spend without a second request.

### Aggregation

`GET /api/v1/usage?project_id=…&group_by=…` rolls a project's usage up over an optional `[from, to]` window (inclusive ISO-8601 bounds on the event `created_at`; omit either for an open bound), bucketed by a single dimension — `model`, `agent`, `run`, `day` (the event's UTC calendar day), `meter_type`, `actor`, or `session`. Each group and the grand `totals` carry summed token counts (`input_tokens` is uncached input + cached, mirroring the receipt) and `cost_usd` (`null` when no event in the bucket was priced). This is the per-project cost-by-range/by-category query — a monthly figure without scanning raw meter rows client-side. A bucket whose dimension does not apply to an event (e.g. a standalone generation under `group_by=run`, or any non-session work under `group_by=actor`) collapses into a group with a `null` `key`, so the groups always sum to the project total. Requires `usage:GetUsage` on the project.

#### Measured quantities, not just tokens

The token fields describe `llm_tokens` alone, so every group and the `totals` also carry a `components` array — the same measured dimension the receipt reports per line item, summed over the bucket:

```json
{
  "key": "storage",
  "cost_usd": null,
  "input_tokens": 0,
  "output_tokens": 0,
  "components": [
    { "component": "gb_day", "unit": "gb_day", "quantity": 0.4, "cost_usd": null }
  ]
}
```

An infra meter therefore aggregates to what it measured. Without `components`, a `storage`, `api_request` or `compute_execution` bucket reads as all-zero — indistinguishable from a meter that recorded nothing. As on the receipt, a `null` `cost_usd` means no price row covered the component; the quantity is still captured and does not mean the usage was free. Entries are keyed by `component` **and** `unit` (a quantity is only additive within one unit) and sorted by `component` then `unit`, so the array is stable across calls. Quantities are summed as exact decimals, so a bucket of fractional measures reports `0.3` rather than a float-drifted `0.30000000000000004` — the figure is safe to display and to re-bill from.

#### Narrowing to one meter

For platform meter types `provider` is `soat` and `model` names the billable SKU, so `group_by=model` legitimately mixes model ids with SKUs (`deepseek.v3.2` next to `gb-day`). Add `meter_type=llm_tokens` to ask the model question directly — or `meter_type=storage` to roll up one infra meter alone. The applied filter is echoed back as `meter_type` on the response (`null` when unfiltered), and an unrecognized value yields an empty rollup rather than an error, matching the `meter_type` filter on `GET /api/v1/usage/meters`.

### Spend guards

Metered usage feeds the [guardrail](./guardrails.md) evaluator's `soat.usage.*` context, so a spend limit is enforced deterministically at the tool boundary rather than reported after the fact. Two granularities exist:

- **Per project, windowed** — `soat.usage.cost_usd_{1h,24h,7d,30d}` and `soat.usage.tokens_{24h,30d}`, rolling windows ending at evaluation time.
- **Per run, cumulative** — `soat.usage.run_tokens` and `soat.usage.run_cost_usd`, summing only the meter rows recorded against the current [orchestration run](./orchestrations.md). This is what stops a single runaway cycle, which a project window is too coarse to catch; see [per-run spend ceilings](./guardrails.md#per-run-spend-ceilings).

Both read live at evaluation time and fail closed. Unlike [thresholds](#thresholds-and-alerts), which alert, a guard **aborts** the call.

### Thresholds and alerts

A project can carry any number of [`UsageThreshold`](#usagethreshold) rules. After **each** usage-event write — the single metering choke point — every threshold on the event's project is evaluated against its windowed aggregate, and a `usage.threshold_crossed` [webhook](./webhooks.md) fires for any that cross. Because evaluation rides the write path, infra meters count toward a `cost_usd` threshold the moment those emitters land.

Re-fire is governed by hysteresis so a project is not spammed while usage hovers at a limit:

- **`calendar_month`** — fires **at most once per window**. On firing, `fired_window_key` is stamped with the current `YYYY-MM`; it cannot fire again until the key changes at the month boundary. Usage in a calendar window only grows (meters are append-only), so no band is needed.
- **`rolling_24h`** — the windowed value can fall as old meters age out, so a fired threshold **re-arms only once the value drops below 90% of the threshold** (a 10% band), then may fire again on the next crossing.

The webhook payload (`data`) is:

```json
{
  "threshold_id": "uthr_V1StGXR8Z5jdHi6B",
  "project_id": "proj_V1StGXR8Z5jdHi6B",
  "metric": "cost_usd",
  "window": "calendar_month",
  "window_key": "2026-07",
  "threshold": 100,
  "observed_value": 101.37
}
```

`window_key` is `null` for `rolling_24h`. Subscribe a webhook to `usage.threshold_crossed` (or `usage.*`) to receive it. Deleting and recreating a threshold resets its fire state.

## Configuration

The infra emitters run on background timers with sane defaults; these tune or disable them.

| Environment Variable | Required | Description |
| --- | --- | --- |
| `USAGE_STORAGE_SNAPSHOT_INTERVAL_MS` | No | Storage-snapshot interval (default daily). |
| `USAGE_STORAGE_SNAPSHOT_DISABLED` | No | `true` disables the storage snapshot. |
| `USAGE_REQUEST_FLUSH_INTERVAL_MS` | No | API-request counter flush interval (default 60000). A freshness-vs-row-volume trade-off. |
| `USAGE_REQUEST_METERING_DISABLED` | No | `true` disables API-request metering (middleware stops counting and the flush timer stops). |
| `SOAT_INSTANCE_ID` | No | Per-instance id folded into the request-flush idempotency key so multiple instances don't collide (falls back to `HOSTNAME`, then `default`). |

## Examples

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-usage-meters --generation-id gen_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.listUsageMeters({
  query: { generation_id: 'gen_V1StGXR8Z5jdHi6B' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage/meters?generation_id=gen_V1StGXR8Z5jdHi6B" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Get a generation's receipt:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage-receipt --generation-id gen_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getUsageReceipt({
  query: { generation_id: 'gen_V1StGXR8Z5jdHi6B' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage/receipt?generation_id=gen_V1StGXR8Z5jdHi6B" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Get a run's receipt (summed across every node of the run):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage-receipt --orchestration-run-id orch_run_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getUsageReceipt({
  query: { orchestration_run_id: 'orch_run_V1StGXR8Z5jdHi6B' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage/receipt?orchestration_run_id=orch_run_V1StGXR8Z5jdHi6B" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Aggregate a project's usage by meter type over a window:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --group-by meter_type \
  --from 2026-07-01T00:00:00Z \
  --to 2026-08-01T00:00:00Z
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getUsage({
  query: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    group_by: 'meter_type',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage?project_id=proj_V1StGXR8Z5jdHi6B&group_by=meter_type&from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Aggregate by model, restricted to LLM spend (so platform SKUs stay out of the model dimension):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --group-by model \
  --meter-type llm_tokens
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getUsage({
  query: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    group_by: 'model',
    meter_type: 'llm_tokens',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage?project_id=proj_V1StGXR8Z5jdHi6B&group_by=model&meter_type=llm_tokens" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Create a usage threshold (alerts when monthly cost crosses 100 USD):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-usage-threshold \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --metric cost_usd \
  --window calendar_month \
  --threshold 100
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.createUsageThreshold({
  body: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    metric: 'cost_usd',
    window: 'calendar_month',
    threshold: 100,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "https://api.example.com/api/v1/usage/thresholds" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_V1StGXR8Z5jdHi6B","metric":"cost_usd","window":"calendar_month","threshold":100}'
```

</TabItem>
</Tabs>

Read the price book:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-price-book
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getPriceBook();
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage/prices" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
