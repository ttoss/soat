---
description: "Usage events record the cost of every metered occurrence — a completed LLM call, an orchestration node's compute, API requests, and stored bytes — attributed to a project, agent, and generation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Usage

Usage events record the cost of every metered occurrence, with the measured quantities held in per-dimension component rows, so spend can be attributed to a project, agent, and generation.

## Overview

Every metered occurrence writes one **usage event** plus its **component** rows: an event captures attribution and total cost; each component captures one priced dimension. Four meter types share the shape — `llm_tokens`, `compute_execution`, `storage`, and `api_request`. Events and components are **append-only and immutable**, and writes are **idempotent**, so historical usage never changes and a replayed completion never double-counts. Every event links back to the [generation](./generations.md), [agent](./agents.md), [trace](./traces.md), [AI provider](./ai-providers.md), [project](./projects.md), and — when applicable — the [trigger](./triggers.md) or [orchestration](./orchestrations.md) run behind it.

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

One priced dimension of an event: `quantity` is always in `unit`, and `cost_usd = quantity × unit_price`.

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

A versioned unit price for one billable **component** of a SKU. Three scopes live in one table, resolved most-specific first: a **per-provider override** (`ai_provider_id` set), a **project + provider-slug** price (`project_id` set, `ai_provider_id` null), and a **global default** (both null). Within each scope the latest `effective_from <= now()` applies.

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

| `meter_type`     | What one event records                              | Components                                        |
| ---------------- | --------------------------------------------------- | ------------------------------------------------- |
| `llm_tokens`     | One completed LLM call's token usage | `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens` |
| `compute_execution` | Wall-clock compute time of a unit of work (orchestration node, agent generation, tool call) | `compute_second`                                     |
| `api_request`    | A batch of API requests served for a project        | `request`                                         |
| `storage`        | One project's stored bytes for one day              | `gb_day`                                          |

For platform meter types the `(provider, model)` pair is a **SKU**: `provider` is `soat` and `model` names the billable unit (e.g. `compute-second`, `gb-day`, `request`).

Token components are disjoint and additive: `input_tokens` is the **uncached** input, so full prompt tokens = `input_tokens` + `cached_tokens`. `reasoning_tokens` is a non-billable subset of `output_tokens`. Cached and reasoning components are recorded only when the provider reports them.

### Coverage

**Every LLM call the platform makes is metered**, through one shared choke point:

| Path | Metered calls | Event attribution |
| --- | --- | --- |
| Agent generations | Agent generate (non-streaming, streaming, and the tool-outputs continuation), [conversations](./conversations.md), and [orchestration](./orchestrations.md) agent nodes | Full chain: `generation_id`, `agent_id`, `trace_id`, plus `orchestration_run_id`/`node_id` inside a run |
| Standalone completions | [Chat](./chats.md) completions (stateless and chat-scoped) and [memory](./memories.md) fact extraction and consolidation | `generation_id` and `trace_id` are `null` — these calls create no generation. `agent_id` is set for memory passes, `null` for chats |

Idempotency keys: inside a run the key is scoped to the node execution (`run:<orchestration_run_id>:node:<node_id>`), so a replayed node is a no-op; standalone completions have no replay identity, so their key is unique per call (`completion:<source>:<uuid>`). A **streamed** completion is metered when the stream finishes; a stream the client abandons mid-way is not metered.

### Compute metering

Every orchestration node execution that actively ran writes one `compute_execution` event carrying a `compute_second` component with the node's wall-clock seconds (`completed_at − started_at`). Non-agent nodes still meter compute; an agent node produces both an `llm_tokens` and a `compute_execution` event. Attribution is at the run/node level (`generation_id`, `agent_id`, `trace_id` are `null`). Priced from a `soat`/`compute-second` SKU when one is effective; idempotent on `compute:<orchestration_run_id>:node:<node_id>:attempt:<n>`. A skipped node is not metered.

### Storage metering

A daily snapshot writes one `storage` event per project per UTC day, carrying a `gb_day` component with the project's stored gigabytes — uploaded [file](./files.md) sizes plus [document](./documents.md) chunk text, summed at snapshot time. No principal/agent/run attribution. Priced from a `soat`/`gb-day` SKU; idempotent on `storage:<project>:<YYYY-MM-DD>`. Intra-day churn between samples meters zero.

### API-request metering

Requests are counted in memory per (project, API key) and a periodic flush writes one `api_request` event per counter per window — deliberately never one row per request. Counting scope mirrors [quotas](./quotas.md#which-project-a-request-counts-against) exactly: only API-key-authenticated requests count, a project-scoped key counts against its bound project, an unscoped key against the project the route resolved and authorized, and a request that resolves to no single project is not counted. Enforcement stays with quotas — this only prices (from a `soat`/`request` SKU). The flush-window idempotency key includes a per-instance id; the last still-open window is lost on an unclean shutdown (a bounded undercount).

### Trigger and action attribution

`action_id` is a caller-supplied label passed on the generate request, persisted on the [generation](./generations.md) and copied onto its event. `trigger_id` is set automatically when a [trigger](./triggers.md) initiates the generation — directly or via an orchestration run the trigger started. Filter the event list by either (`?trigger_id=` / `?action_id=`).

### Workload source

`source` names the workload that produced the spend, so verification and background work are separable from user-serving traffic:

| `source` | What produced the event |
| --- | --- |
| `null` | An ordinary agent generation |
| `eval` | An [eval run](./evaluations.md#eval-spend-is-separable-from-production-spend)'s item generations |
| `eval_judge` | An `llm_judge` scorer's own grading completion |
| `chat` | A standalone [chat](./chats.md) completion |
| `memory_extraction` / `memory_consolidation` | A [memory](./memories.md) pass |

`source` is set by the platform at the metering choke point — a caller cannot bill eval spend as production. It both filters ([`GET /api/v1/usage/meters?source=eval`](/docs/api/usage/list-usage-meters)) and groups (`group_by=source`); ordinary traffic collapses into the `null` bucket, so groups still sum to the project total.

### End-user attribution

An event carries the [actor](./actors.md) and [session](./sessions.md) it was produced for, copied from the generation at write time and **frozen** — renaming or deleting either never rewrites recorded spend. Attribution is set on the session path only; direct agent generations, trigger-initiated work, orchestration nodes, and standalone completions record `null` for both. The actor is **derived from the session**, never taken from the request (`tool_context` is caller-writable and is not read for attribution). Both dimensions filter (`?actor_id=` / `?session_id=`) and group (`group_by=actor` / `group_by=session`). Events recorded before this shipped carry `null`.

### Pricing

Each component's cost is computed at write time from the effective price row for its `(provider, model, component)`, resolved most-specific first: AI provider instance → project + provider-slug → global default. Costs are frozen onto the components; later price changes never alter them. `cached_tokens` falls back to the `input_tokens` rate when no cached price is set. A `null` `cost_usd` means no price row covered the component — the quantity is still captured. Each component records `price_id`, so a receipt is auditable to the precise price applied.

SOAT ships **no default prices**. Prices are managed where their scope lives:

- **Global defaults** — admins via [`PUT /api/v1/usage/prices`](/docs/api/usage/upsert-price-book). [`GET /api/v1/usage/prices`](/docs/api/usage/get-price-book) lists only these.
- **Project + provider-slug** — project members via [`PUT /api/v1/projects/{project_id}/prices`](./projects.md).
- **Per-provider override** — project members via [`PUT /api/v1/ai-providers/{ai_provider_id}/prices`](./ai-providers.md#price-overrides).

Past-effective prices are immutable — corrections ship as new future-dated rows. Prices can also be **declared in a formation** with the `project_price` resource type, keyed on `(provider, model, component, effective_from)`; there `effective_from` is optional and defaults to deploy time. See [Formations Types → Project Price](/docs/formations-types/project-price).

### Receipts and reconciliation

[`GET /api/v1/usage/receipt?generation_id=…`](/docs/api/usage/get-usage-receipt) returns a billing **receipt** for a completed generation: one line item per usage event, a `by_meter_type` cost split, reconstructed token totals (`total_input_tokens` is uncached input + cached), and a grand total. Because every component carries its price-book version and frozen cost, receipts are reproducible and meant to reconcile against the provider's invoice within a small tolerance (target ±2%).

[`GET /api/v1/usage/receipt?orchestration_run_id=…`](/docs/api/usage/get-usage-receipt) returns the same shape for an entire [orchestration](./orchestrations.md) run, summed across every node. The run's roll-up is also surfaced inline as a `usage` object on [`GET /api/v1/orchestration-runs/{orchestration_run_id}`](/docs/api/orchestrations/get-orchestration-run).

Every line item carries the `node_id` that produced it, so a run receipt is also the **per-node cost breakdown** — group the lines by `node_id` and each node's spend is the sum of its lines. Both meters appear under the node: an `agent` node's `llm_tokens` line and the `compute_execution` line of every node execution, so a pure node (a `transform`, a `condition`) shows up with its execution cost alone. Two things to know when reading it:

- **A retried node's attempts share one `node_id`.** The event records no attempt number, which is the intended reading for spend — a retry is real money, so it belongs in the node's total.
- **A `null` `node_id`** means no node produced the event: a standalone generation on a per-generation receipt, or a run-level meter.

A run whose graph contains a `loop` or `sub_orchestration` node is only partly covered: those nodes start child runs, whose events are attributed to the child, so the parent's receipt shows the node's own execution cost and not what the children spent. See [Run usage](./orchestrations.md#run-usage).

### Aggregation

[`GET /api/v1/usage?project_id=…&group_by=…`](/docs/api/usage/get-usage) rolls a project's usage up over an optional `[from, to]` window (inclusive ISO-8601 bounds on `created_at`), bucketed by one dimension — `model`, `agent`, `run`, `day`, `meter_type`, `actor`, `session`, or [`source`](#workload-source). Each group and the grand `totals` carry summed token counts and `cost_usd` (`null` when no event in the bucket was priced). An event a dimension does not apply to collapses into a `null`-keyed group, so groups always sum to the project total. Requires `usage:GetUsage` on the project.

Every group also carries a `components` array — the measured dimensions summed over the bucket — so an infra meter aggregates to what it measured rather than reading as all-zero tokens. Entries are keyed by `component` **and** `unit` and sorted, and quantities are summed as exact decimals (no float drift).

For platform meter types `group_by=model` mixes model ids with SKUs; add `meter_type=llm_tokens` (or another meter type) to narrow to one meter. The applied filter is echoed back as `meter_type` on the response; an unrecognized value yields an empty rollup rather than an error.

### Spend guards

Metered usage feeds the [guardrail](./guardrails.md) evaluator's `runtime.usage.*` context, so a spend limit is enforced deterministically at the tool boundary:

- **Per project, windowed** — `runtime.usage.cost_usd_{1h,24h,7d,30d}` and `runtime.usage.tokens_{24h,30d}`.
- **Per run, cumulative** — `runtime.usage.run_tokens` and `runtime.usage.run_cost_usd`; see [per-run spend ceilings](./guardrails.md#per-run-spend-ceilings).

Both read live at evaluation time and fail closed. Unlike [thresholds](#thresholds-and-alerts), which alert, a guard **aborts** the call.

### Thresholds and alerts

After **each** usage-event write, every [`UsageThreshold`](#usagethreshold) on the event's project is evaluated against its windowed aggregate, and a `usage.threshold_crossed` [webhook](./webhooks.md) fires for any that cross. Re-fire hysteresis:

- **`calendar_month`** — fires at most once per window; `fired_window_key` blocks re-fire until the `YYYY-MM` key changes.
- **`rolling_24h`** — re-arms only once the value drops below 90% of the threshold, then may fire again.

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

`window_key` is `null` for `rolling_24h`. Subscribe a webhook to `usage.threshold_crossed` (or `usage.*`) to receive it.

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `USAGE_STORAGE_SNAPSHOT_INTERVAL_MS` | No | Storage-snapshot interval (default daily). |
| `USAGE_STORAGE_SNAPSHOT_DISABLED` | No | `true` disables the storage snapshot. |
| `USAGE_REQUEST_FLUSH_INTERVAL_MS` | No | API-request counter flush interval (default 60000). A freshness-vs-row-volume trade-off. |
| `USAGE_REQUEST_METERING_DISABLED` | No | `true` disables API-request metering (middleware stops counting and the flush timer stops). |
| `SOAT_INSTANCE_ID` | No | Per-instance id folded into the request-flush idempotency key so multiple instances don't collide (falls back to `HOSTNAME`, then `default`). |

## Examples

List a generation's raw meter rows:

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

Get a generation's receipt (pass `orchestration_run_id` instead for a whole run, whose lines carry `node_id`):

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
