---
description: "Usage events record the cost of every metered occurrence — a completed LLM call, an orchestration node's compute, API requests, and stored bytes — attributed to a project, agent, and generation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Usage

Usage events record the cost of every metered occurrence, with the measured quantities held in per-dimension component rows, so spend can be attributed to a project, agent, and generation.

## Overview

Every metered occurrence writes one **usage event** (attribution, total cost) plus **component** rows (one priced dimension each). Four meter types share the shape: `llm_tokens`, `compute_execution`, `storage`, `api_request`. Events and components are **append-only and immutable**; writes are **idempotent**, so a replayed completion never double-counts. Each event links to its [generation](./generations.md), [agent](./agents.md), [trace](./traces.md), [AI provider](./ai-providers.md), [project](./projects.md), and, when applicable, [trigger](./triggers.md) or [orchestration](./orchestrations.md) run.

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
| `ai_provider_id` | string \| null  | AI provider instance billed; correlates the event to the price book. On a [routed](./model-routes.md) generation this is the target the route actually picked, not the agent's binding (a routed agent pins no provider) |
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
| `component`  | string          | The measured dimension: `input_tokens`, `output_tokens`, `cached_tokens`, `cache_write_tokens`, `reasoning_tokens`, `compute_second`, `request`, `gb_day`, `chunk_count`, … |
| `quantity`   | number          | The measured amount, expressed in `unit`                                                      |
| `unit`       | string          | Unit `quantity` is measured in (`token`, `compute_second`, `request`, `gb_day`, `count`)         |
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

A per-project alert rule: when `metric` over `window` crosses `threshold`, a `usage.threshold_crossed` [webhook](./webhooks.md) fires. Immutable apart from deletion; delete and recreate to change one (resets its fire state).

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
| `llm_tokens`     | One completed LLM call's token usage | `input_tokens`, `output_tokens`, `cached_tokens`, `cache_write_tokens`, `reasoning_tokens` |
| `compute_execution` | Wall-clock compute time of a unit of work (orchestration node, agent generation, tool call) | `compute_second`                                     |
| `api_request`    | A batch of API requests served for a project        | `request`                                         |
| `storage`        | One project's stored footprint for one day          | `gb_day`, `chunk_count`                           |

For platform meter types `(provider, model)` is a **SKU**: `provider` is `soat`, `model` the billable unit (`compute-second`, `gb-day`, `request`).

#### Token components

Token components are disjoint and additive. The provider reports one prompt figure covering three different prices, and SOAT splits it into three components so each is priced at the rate it is actually charged at:

| Component | What it counts | How it prices against uncached input |
| --- | --- | --- |
| `input_tokens` | Prompt tokens neither read from nor written to the provider's prompt cache | the baseline |
| `cached_tokens` | Prompt tokens served **from** the cache | far cheaper |
| `cache_write_tokens` | Prompt tokens written **into** the cache | dearer |

So full prompt tokens = `input_tokens` + `cached_tokens` + `cache_write_tokens`, and `input_tokens` is **uncached input alone** — never the provider's total. `reasoning_tokens` is a non-billable subset of `output_tokens`. The cache and reasoning components are recorded only when the provider reports them, so a call that cached nothing carries neither.

Cache activity appears only for an agent that asked for it — see [Agents — Prompt Caching](./agents.md#prompt-caching).

### Coverage

**Every LLM call the platform makes is metered**, through one shared choke point:

| Path | Metered calls | Event attribution |
| --- | --- | --- |
| Agent generations | Agent generate (non-streaming, streaming, and the tool-outputs continuation), [conversations](./conversations.md), and [orchestration](./orchestrations.md) agent nodes | Full chain: `generation_id`, `agent_id`, `trace_id`, plus `orchestration_run_id`/`node_id` inside a run |
| Standalone completions | [Chat](./chats.md) completions (stateless and chat-scoped) and [memory](./memories.md) fact extraction and consolidation | `generation_id` and `trace_id` are `null` — these calls create no generation. `agent_id` is set for memory passes, `null` for chats |

Idempotency keys: inside a run, the node execution **attempt** (`run:<orchestration_run_id>:node:<node_id>:attempt:<n>`), so a replayed node is a no-op while a **retry** meters for real; the same identity keys the `compute_execution` meter and the node-execution record. Standalone completions have no replay identity: `completion:<source>:<uuid>`. A **streamed** completion is metered when the stream finishes; one the client abandons is not.

A `failed` turn is metered when it spent something: a generation the model *answered* but that failed the agent's [`output_schema`](./agents.md) with `OUTPUT_SCHEMA_VALIDATION_FAILED` was billed, and the counts come back on the failure. A request that never reached the model (provider `4xx`/`5xx`, network fault) writes no event, so a failed generation with no usage row means the call never landed.

### Compute metering

Every orchestration node execution that actively ran writes one `compute_execution` event with a `compute_second` component of wall-clock seconds (`completed_at − started_at`). Non-agent nodes meter compute too; an agent node produces both an `llm_tokens` and a `compute_execution` event. Attribution is run/node level (`generation_id`, `agent_id`, `trace_id` `null`). Priced from a `soat`/`compute-second` SKU when effective; idempotent on `compute:<orchestration_run_id>:node:<node_id>:attempt:<n>`. A skipped node is not metered.

### Storage metering

A daily snapshot writes one `storage` event per project per UTC day with two components measured in one statement: `gb_day` (stored gigabytes) and `chunk_count` (indexed rows behind them). No principal/agent/run attribution. Both are priced from the `soat`/`gb-day` SKU, each from its own component row; the event's cost is their sum. Idempotent on `storage:<project>:<YYYY-MM-DD>`, so the run at server startup re-samples the current day; intra-day churn meters zero; an unpriced component records its quantity with `cost_usd` null.

`gb_day` sums seven terms:

| Term | Source |
| --- | --- |
| Uploaded file bytes | [`files.size`](./files.md) |
| Chunk text | [document](./documents.md) chunk `content` |
| Chunk embeddings | the stored width of each chunk's vector |
| Memory entry text | [memory entry](./memories.md) `content` |
| Memory entry embeddings | the stored width of each entry's vector |
| Dataset item payloads | [dataset item](./evaluations.md) `input`, `expected_output`, `metadata` |
| Eval result payloads | [eval result](./evaluations.md) `input`, `expected_output`, `scores`, `output` |

`chunk_count` counts [document](./documents.md) chunks plus [memory entries](./memories.md), embedded or not (a row joins the vector index once its embedding is written). Dataset items and eval results carry no vector and are not counted.

- **The evaluations corpus grows with runs, not the dataset.** An eval result [freezes its own copy](./evaluations.md#frozen-inputs) of the item it scored: a 100-item dataset run ten times stores eleven copies of every payload. [Retention](./evaluations.md#retention-and-erasure) clears a result's `output` only.
- **The snapshot bounds the corpus.** A `storage_bytes` [quota](./quotas.md#storage-enforcement) caps the footprint against the newest `storage` event plus the request's delta, refusing corpus writes with `409 QUOTA_STORAGE_EXCEEDED`; this keeps the check off the per-upload path at up to a day of staleness.
- **Embeddings dominate.** Four bytes per dimension: at `EMBEDDING_DIMENSIONS=1024` one embedding is ~4 KB against ~1 KB of text. A row without an embedding contributes its text only. Vector widths are measured from the stored value, not computed from `EMBEDDING_DIMENSIONS`.
- **Physical overhead is excluded from `gb_day`.** Index pages (including the HNSW graphs over both vector columns), TOAST chunk and tuple headers, and table bloat are not counted: none is attributable to one project and it moves with vacuum state. Real disk use is higher by a deployment-dependent factor.
- **`chunk_count` is what that overhead is priced against.** Most of a chunk's cost is fixed per row: at `EMBEDDING_DIMENSIONS=1024` an HNSW element occupies a whole 8 KiB page (4 KB vector plus neighbour list) on top of the ~5.5 KB stored out of line. On a mirrored schema, a 25× change in chunk size moves a chunk's cost by 17%, while the same corpus re-chunked meters between 2.2× and 7.4× its source size on `gb_day`. A count does not drift with the caller's [`chunk_strategy`](./documents.md), and distinguishes a few large documents from a million tiny chunks, alike on `gb_day` and unlike on search.

### API-request metering

Requests are counted in memory per (project, API key); a periodic flush writes one `api_request` event per counter per window, never one row per request. Counting scope mirrors [quotas](./quotas.md#which-project-a-request-counts-against): only API-key-authenticated requests count, a project-scoped key against its bound project, an unscoped key against the project the route resolved and authorized, none when no single project resolves. Enforcement stays with quotas; this only prices (`soat`/`request` SKU). The flush-window idempotency key includes a per-instance id; the last open window is lost on an unclean shutdown (a bounded undercount).

### Trigger and action attribution

`action_id` is a caller-supplied label on the generate request, persisted on the [generation](./generations.md) and copied onto its event. `trigger_id` is set when a [trigger](./triggers.md) initiates the generation, directly or via an orchestration run it started. Filter the event list by either (`?trigger_id=` / `?action_id=`).

### Workload source

`source` names the workload behind the spend, separating verification and background work from user-serving traffic:

| `source` | What produced the event |
| --- | --- |
| `null` | An ordinary agent generation |
| `eval` | An [eval run](./evaluations.md#eval-spend-is-separable-from-production-spend)'s item generations |
| `eval_judge` | An `llm_judge` scorer's own grading completion |
| `chat` | A standalone [chat](./chats.md) completion |
| `memory_extraction` / `memory_consolidation` | A [memory](./memories.md) pass |
| `embedding` | An [embedding](./embeddings.md#metering) call — the endpoint, document ingestion, a memory write, or a search's query vector |

Set by the platform at the metering choke point; a caller cannot bill eval spend as production. Filters ([`GET /api/v1/usage/events?source=eval`](/docs/api/usage/list-usage-events)) and groups (`group_by=source`); ordinary traffic is the `null` bucket, so groups sum to the project total.

### Provider attribution

An event bills against the provider that served it: the target a [model route](./model-routes.md) picked (read from what the turn did, so a failed-over generation meters against the target that answered), or the agent's pinned provider. An event with no provider resolves no price row and reports the `unknown` provider slug.

### End-user attribution

An event carries the [actor](./actors.md) and [session](./sessions.md) it was produced for, copied from the generation at write time and **frozen**; renaming or deleting either never rewrites spend. Set on the session path only; direct agent generations, trigger-initiated work, orchestration nodes, and standalone completions record `null` for both. The actor is **derived from the session**, never from the request (`tool_context` is caller-writable and not read). Events recorded before this shipped carry `null`.

| Question | Read |
| --- | --- |
| What did this conversation cost? | The `usage` object on [`GET /api/v1/sessions/{session_id}`](/docs/api/sessions/get-session) — see [Session cost](./sessions.md#session-cost) |
| What has this end user cost, over a window or split by day/model? | [`GET /api/v1/usage/aggregate`](/docs/api/usage/get-usage-aggregate) with `actor_id=` (or `session_id=`), with or without a `group_by` |
| Which sessions or users are the biggest spenders? | The same endpoint with `group_by=session` or `group_by=actor` |
| Which turns made up that spend? | [`GET /api/v1/generations`](/docs/api/generations/list-generations) with `session_id=` or `actor_id=` |

`session_id` and `actor_id` are two of the [thirteen narrowings](#narrowing-a-rollup); both narrow the **whole** rollup and compose with any `group_by`. `actor_id` is the figure behind an `actor`-scoped `cost_usd` [quota](./quotas.md#actor-scope). The same pair is on the generation record ([`GET /api/v1/generations/{generation_id}`](/docs/api/generations/get-generation)), filters the generation listing, and filters the raw event listing (`?actor_id=` / `?session_id=` on [`GET /api/v1/usage/events`](/docs/api/usage/list-usage-events)), so a consumer can walk session → generation → components without recording the link itself.

### Pricing

Each component's cost is computed at write time from the effective price row for its `(provider, model, component)`, most-specific first: AI provider instance → project + provider-slug → global default. Costs are frozen; later price changes never alter them. `cached_tokens` and `cache_write_tokens` each fall back to the `input_tokens` rate when no row of their own is set — never to zero, so an unpriced cache column meters at the plain input rate rather than quietly understating `cost_usd`. A `null` `cost_usd` means no row covered the component; the quantity is still captured. Each component records `price_id`, so a receipt is auditable to the price applied.

- **The cache components are components in their own right, not slices of `input_tokens`.** The `input_tokens` *component* is uncached input only, so pricing all three double-counts nothing; the reconstructed `input_tokens` *field* on receipt and aggregate totals is the full prompt count (`input_tokens` + `cached_tokens` + `cache_write_tokens` components). Price the components; read the fields.
- **Price the write, not just the read.** Until a `cache_write_tokens` row exists, a write bills at the uncached input rate — which understates it on every provider that charges a premium for one. Add the row before turning caching on at scale.
- **Pricing is not retroactive.** A component metered before any row priced it stays `cost_usd: null`; there is no backfill. The [first-price exception](#pricing) lets the first row be dated now or earlier, so write it before the traffic. Quantities survive, so an unpriced window can still be costed outside the platform.
- **Embeddings are the one exception.** No tier prices an embedding call: it carries no provider record and its rate is deployment configuration (`EMBEDDING_INPUT_1M_TOKEN_PRICE_USD`), so a price book row naming the embedding model is ignored. See [Pricing embeddings](./embeddings.md#pricing-embeddings).

SOAT ships **no default prices**. Prices are managed where their scope lives:

- **Global defaults** — admins via [`PUT /api/v1/usage/prices`](/docs/api/usage/upsert-price-book). [`GET /api/v1/usage/prices`](/docs/api/usage/get-price-book) lists only these.
- **Project + provider-slug** — project members via [`PUT /api/v1/projects/{project_id}/prices`](./projects.md).
- **Per-provider override** — project members via [`PUT /api/v1/ai-providers/{ai_provider_id}/prices`](./ai-providers.md#price-overrides).

Past-effective prices are immutable; corrections ship as future-dated rows. A **first** price is the exception: when nothing prices a `(provider, model, component)` in the scope being written or any broader one it resolves through, `effective_from` may be now or earlier (a forced future date would charge `null` until it lands). Prices can also be **declared in a formation** with the `project_price` resource type, keyed on `(provider, model, component, effective_from)`, where `effective_from` is optional and defaults to deploy time. See [Formations Types → Project Price](/docs/formations-types/project-price).

Each `PUT` takes a batch and stops at the first refused row. Both refusals, an unparseable `effective_from` and a now-or-past-dated write onto an already priced `(provider, model, component)`, return `400 VALIDATION_FAILED` with the failing row in `error.meta` as `provider`, `model`, `component` and `effective_from`.

### Receipts and reconciliation

[`GET /api/v1/usage/receipt?generation_id=…`](/docs/api/usage/get-usage-receipt) returns a billing **receipt** for a completed generation: one line item per usage event, a `by_meter_type` cost split, reconstructed token totals (`input_tokens` is uncached input + cached), and a grand total. Every component carries its price-book version and frozen cost, so receipts are reproducible and reconcile against the provider's invoice within a small tolerance (target ±2%).

[`GET /api/v1/usage/receipt?orchestration_run_id=…`](/docs/api/usage/get-usage-receipt) returns the same shape for an [orchestration](./orchestrations.md) run, summed across every node; the roll-up is also the `usage` object on [`GET /api/v1/orchestration-runs/{orchestration_run_id}`](/docs/api/orchestrations/get-orchestration-run).

Every line item carries its `node_id`, so a run receipt is also the **per-node cost breakdown**: an `agent` node's `llm_tokens` line plus the `compute_execution` line of every node execution, so a pure node (a `transform`, a `condition`) shows its execution cost alone.

- **A retried node's attempts share one `node_id`**: one line per attempt, no attempt number on the event. A retry is real money, so it belongs in the node's total.
- **A `null` `node_id`** means no node produced the event: a standalone generation on a per-generation receipt, or a run-level meter.

A `loop` or `sub_orchestration` node starts child runs whose events are attributed to the child, so the parent's receipt covers its **own** nodes only: the starting node's execution cost, not what the children spent (merging would mix node ids from two graphs). The run's `usage` field spans the subtree; `usage_own` is the run's own nodes; the `parent_orchestration_run_id` filter lists the children. See [Run usage](./orchestrations.md#run-usage).

### Aggregation

[`GET /api/v1/usage/aggregate?project_id=…`](/docs/api/usage/get-usage-aggregate) rolls a project's usage up over an optional `[from, to]` window (inclusive ISO-8601 bounds on `created_at`), optionally bucketed by one dimension: `model`, `ai_provider`, `agent`, `orchestration_run`, `day`, `meter_type`, `actor`, `session`, or [`source`](#workload-source). `ai_provider` buckets on the provider billed (see [Provider attribution](#provider-attribution)). Each group and the grand `totals` carry `event_count`, summed token counts and `cost_usd` (`null` when nothing in the bucket was priced). An event a dimension does not apply to falls in a `null`-keyed group, so groups always sum to the project total. Requires `usage:GetAggregate` on the project.

**`group_by` is optional.** Omitted, it echoes back `null`, `groups` is an empty page, and `totals` describes the whole window. A value naming no dimension is a `400`.

#### Narrowing a rollup

Thirteen filters narrow the rollup before bucketing. They intersect and apply to the **whole** rollup (every bucket, `totals`, `totals.distinct`), so each composes with any `group_by`: `session_id` with `group_by=day` is one conversation's spend per day, with `group_by=model` the same spend by model.

| Filter | Selects |
| --- | --- |
| `session_id`, `actor_id` | One conversation, or one end user across every session ([End-user attribution](#end-user-attribution)) |
| `agent_id`, `ai_provider_id` | One agent's traffic; the spend billed against one provider record |
| `orchestration_run_id`, `orchestration_id` | One run; every run of one orchestration |
| `generation_id`, `trace_id` | One generation's events; everything recorded under one trace |
| `meter_type`, `model`, `source` | One meter, one as-billed SKU, one [workload source](#workload-source) |
| `trigger_id`, `action_id` | The spend one trigger initiated; one caller-supplied action label |

The **eight naming a resource** are resolved against the project first; an id naming nothing empties the rollup rather than dropping the filter, so a mistyped id never reads back as the project's whole spend. The **five carrying a value** are matched as the event recorded them, so an unrecognised meter, model or source selects no events; `trigger_id` and `action_id` are values because the event stores them denormalized and the spend outlives the trigger.

`orchestration_id` selects the runs that orchestration started **itself**, never the subtree a `loop` or `sub_orchestration` node started (metered against the child orchestration), so summed across a project's orchestrations it reaches the project total exactly once. For one invocation's subtree, read `usage` on the run ([Run usage](./orchestrations.md#run-usage)).

Every narrowing is echoed under `filters` on the response, `null` when unset, so a rollup of zeros is distinguishable from a project that spent nothing. The same filters (plus `limit`/`offset`) narrow the raw event listing at [`GET /api/v1/usage/events`](/docs/api/usage/list-usage-events).

**An unrecognised query parameter is a `400`**, not ignored (`?group_by=day&model=…` once returned the project-wide total as if it were one model's). The accepted names are in the error message.

The rollup is grouped and summed in SQL with one join for the chosen dimension, so request cost tracks the buckets answered, not the events behind them.

#### Counting entities

**`groups.total` counts buckets, not entities.** The `null`-keyed bucket is real: a project whose traffic is direct agent generations, eval items and trigger firings has exactly **one** `group_by=orchestration_run` bucket whether the window held ten events or a million. `actor`, `session`, `agent` and `source` carry the same null bucket.

To count entities, send `include=distinct` and read `totals.distinct`, one `COUNT(DISTINCT …)` per attribution column:

```bash
GET /api/v1/usage/aggregate?project_id=…&group_by=day&limit=1&include=distinct
```

```json
{
  "totals": {
    "cost_usd": 12.34,
    "event_count": 812004,
    "distinct": {
      "generations": 811990,
      "traces": 811990,
      "orchestration_runs": 12,
      "agents": 4,
      "actors": 318,
      "sessions": 902,
      "ai_providers": 2
    }
  }
}
```

Nulls are not counted: a generation-less completion (`chat`, `memory_extraction`, `memory_consolidation`, `eval_judge`) moves `event_count` and nothing in `distinct`; a standalone generation counts under `generations`, not `orchestration_runs`; a retried orchestration node counts once as a run.

- **Opt-in because it costs**: each key sorts the window once more. Count entities with one request at `limit=1&include=distinct`; page for spend with no `include`.
- **On `totals` only**; groups never carry `distinct` (a `COUNT(DISTINCT)` per bucket).
- **Figures describe one window and do not add**: adjacent windows' `distinct.sessions` overlap where a session spans the boundary, and a run straddling midnight is in two `day` windows. A wider figure is a wider query.

Any `include` value other than `distinct` is a `400`.

#### Paging the groups

`groups` is the standard paginated envelope (`data`, `total`, `limit`, `offset`), where `total` is the bucket count described above.

- **`totals` and `groups.total` always describe the whole `[from, to]` window**, never the page.
- **Groups are ordered by `cost_usd` descending**, ties by `key` then `ai_provider_id` ascending, nulls last: the first page is the biggest spenders, and paging never repeats or skips a bucket, even in a window nothing has priced.

`limit` defaults to 50 and is clamped to 100, as everywhere in the API.

Every group carries a `components` array, the measured dimensions summed over the bucket, so an infra meter aggregates to what it measured rather than all-zero tokens. Entries are keyed by `component` **and** `unit`, sorted; quantities are summed as exact decimals.

For platform meter types `group_by=model` mixes model ids with SKUs; add `meter_type=llm_tokens` (or another meter type) to narrow. The filter is echoed as `filters.meter_type`; an unrecognized value yields an empty rollup, not an error.

Under `group_by=model` every group also carries `ai_provider_id`, the [AI provider](./ai-providers.md) that served it (`null` on every other dimension), because one project can hold two providers serving byte-identical model names: the dimension buckets on model id **and** provider, so one name served by two providers is two groups with the same `key` and different `ai_provider_id`. Groups still sum to `totals`.

### Spend guards

Metered usage feeds the [guardrail](./guardrails.md) evaluator's `runtime.usage.*` context, so a spend limit is enforced deterministically at the tool boundary:

- **Per project, windowed** — `runtime.usage.cost_usd_{1h,24h,7d,30d}` and `runtime.usage.tokens_{24h,30d}`.
- **Per run, cumulative** — `runtime.usage.orchestration_run_tokens` and `runtime.usage.orchestration_run_cost_usd`; see [per-run spend ceilings](./guardrails.md#per-run-spend-ceilings).

Both read live at evaluation time and fail closed. Unlike [thresholds](#thresholds-and-alerts), which alert, a guard **aborts** the call.

### Thresholds and alerts

After **each** usage-event write, every [`UsageThreshold`](#usagethreshold) on the project is evaluated against its windowed aggregate; `usage.threshold_crossed` [webhook](./webhooks.md) fires for any that cross. Re-fire hysteresis:

- **`calendar_month`** — at most once per window; `fired_window_key` blocks re-fire until the `YYYY-MM` key changes.
- **`rolling_24h`** — re-arms once the value drops below 90% of the threshold.

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
soat list-usage-events --generation-id gen_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.listUsageEvents({
  query: { generation_id: 'gen_V1StGXR8Z5jdHi6B' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage/events?generation_id=gen_V1StGXR8Z5jdHi6B" \
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
soat get-usage-aggregate \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --group-by meter_type \
  --from 2026-07-01T00:00:00Z \
  --to 2026-08-01T00:00:00Z
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getUsageAggregate({
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
curl "https://api.example.com/api/v1/usage/aggregate?project_id=proj_V1StGXR8Z5jdHi6B&group_by=meter_type&from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

Count the runs in a billing cycle without listing them: `totals.distinct` is the answer (`groups.total` counts buckets, not runs), and `limit=1` keeps the response small:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage-aggregate \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --group-by orchestration_run \
  --from 2026-07-01T00:00:00Z \
  --to 2026-08-01T00:00:00Z \
  --include distinct \
  --limit 1
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.usage.getUsageAggregate({
  query: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    group_by: 'orchestration_run',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    include: 'distinct',
    limit: 1,
  },
});
if (error) throw new Error(JSON.stringify(error));
const runCount = data.totals.distinct.orchestration_runs;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/usage/aggregate?project_id=proj_V1StGXR8Z5jdHi6B&group_by=orchestration_run&from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z&include=distinct&limit=1" \
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
