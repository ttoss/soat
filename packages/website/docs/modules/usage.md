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
| `component`  | string          | The measured dimension: `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `compute_second`, `request`, `gb_day`, `chunk_count`, … |
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
| `storage`        | One project's stored footprint for one day          | `gb_day`, `chunk_count`                           |

For platform meter types the `(provider, model)` pair is a **SKU**: `provider` is `soat` and `model` names the billable unit (e.g. `compute-second`, `gb-day`, `request`).

Token components are disjoint and additive: `input_tokens` is the **uncached** input, so full prompt tokens = `input_tokens` + `cached_tokens`. `reasoning_tokens` is a non-billable subset of `output_tokens`. Cached and reasoning components are recorded only when the provider reports them.

### Coverage

**Every LLM call the platform makes is metered**, through one shared choke point:

| Path | Metered calls | Event attribution |
| --- | --- | --- |
| Agent generations | Agent generate (non-streaming, streaming, and the tool-outputs continuation), [conversations](./conversations.md), and [orchestration](./orchestrations.md) agent nodes | Full chain: `generation_id`, `agent_id`, `trace_id`, plus `orchestration_run_id`/`node_id` inside a run |
| Standalone completions | [Chat](./chats.md) completions (stateless and chat-scoped) and [memory](./memories.md) fact extraction and consolidation | `generation_id` and `trace_id` are `null` — these calls create no generation. `agent_id` is set for memory passes, `null` for chats |

Idempotency keys: inside a run the key is scoped to the node execution **attempt** (`run:<orchestration_run_id>:node:<node_id>:attempt:<n>`), so a replayed node is a no-op while a **retry** meters for real — a second attempt is a second generation that reached the provider, and dropping it would under-report the node. The same identity keys the `compute_execution` meter and the node-execution record, so all three agree on what one attempt is. Standalone completions have no replay identity, so their key is unique per call (`completion:<source>:<uuid>`). A **streamed** completion is metered when the stream finishes; a stream the client abandons mid-way is not metered.

A turn that ends `failed` is metered when it spent something. The case that matters is a generation the model *answered* — the text just did not satisfy the agent's [`output_schema`](./agents.md), so the turn fails with `OUTPUT_SCHEMA_VALIDATION_FAILED` — because the provider billed for those tokens either way and the counts come back on the failure. A request that never reached the model (a provider `4xx`/`5xx`, a network fault) burned nothing and writes no event, so a failed generation with no usage row means the call never landed rather than that metering was skipped.

### Compute metering

Every orchestration node execution that actively ran writes one `compute_execution` event carrying a `compute_second` component with the node's wall-clock seconds (`completed_at − started_at`). Non-agent nodes still meter compute; an agent node produces both an `llm_tokens` and a `compute_execution` event. Attribution is at the run/node level (`generation_id`, `agent_id`, `trace_id` are `null`). Priced from a `soat`/`compute-second` SKU when one is effective; idempotent on `compute:<orchestration_run_id>:node:<node_id>:attempt:<n>`. A skipped node is not metered.

### Storage metering

A daily snapshot writes one `storage` event per project per UTC day, carrying two components measured in the same statement: `gb_day` (the project's stored gigabytes) and `chunk_count` (the indexed rows behind them). No principal/agent/run attribution. Both are priced from the `soat`/`gb-day` SKU, each from its own component row, and the event's cost is their sum; idempotent on `storage:<project>:<YYYY-MM-DD>`. Intra-day churn between samples meters zero. Either component may be left unpriced — it still records its quantity, with `cost_usd` null.

The snapshot also runs once at server startup, so a deployment that restarts more often than the interval still meters every day it is up. Being idempotent per project per UTC day, a restart re-samples the current day rather than writing a second event for it.

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

`chunk_count` counts the rows behind two of them — [document](./documents.md)
chunks plus [memory entries](./memories.md) — embedded or not, since a row joins
the vector index as soon as its embedding is written. A dataset item and an eval
result carry no vector, so neither joins that index and neither is counted there.

**The evaluations corpus grows with runs, not with the dataset.** An eval result
[freezes its own copy](./evaluations.md#frozen-inputs) of the item it scored, so
a 100-item dataset run ten times stores eleven copies of every payload. Content
[retention](./evaluations.md#retention-and-erasure) clears a result's `output`
and nothing else of it, so the rest accumulates for the life of the project.

**The snapshot is also what bounds the corpus.** A `storage_bytes`
[quota](./quotas.md#storage-enforcement) caps a project's footprint against the
newest `storage` event plus the request's own delta, and refuses the corpus write
paths with `409 QUOTA_STORAGE_EXCEEDED`. Enforcing against the snapshot rather
than a live scan is what keeps the check off the per-upload path, at the cost of
up to a day of staleness.

**Embeddings dominate.** A vector is four bytes per dimension, so at
`EMBEDDING_DIMENSIONS=1024` one embedding is ~4 KB against the ~1 KB of text it
encodes. A row with no embedding yet contributes its text and nothing more. Both
vector widths are measured from the stored value rather than computed from
`EMBEDDING_DIMENSIONS`, so the figure follows that setting without being pinned
to it.

**Physical overhead is excluded from `gb_day`, deliberately.** That component is
the logical bytes a project stored: index pages (including the HNSW graphs over
both vector columns), TOAST chunk and tuple headers, and table bloat are not
counted. None of it is attributable to a single project, and it moves with vacuum
state, so including it would make one project's figure depend on every other
project's write history. Real disk use is therefore higher than `gb_day` reports —
by a factor that depends on the deployment, not on the project.

**`chunk_count` is what that overhead is priced against.** Most of what a chunk
costs is fixed per row rather than proportional to its text: at
`EMBEDDING_DIMENSIONS=1024` an HNSW element occupies a whole 8 KiB page — a
4 KB vector plus its neighbour list leaves no room for a second element — on top
of the ~5.5 KB the vector itself stores out of line. Measured against a mirrored
schema, a 25× change in chunk size moves the cost of a chunk by 17%, so the same
corpus re-chunked meters between 2.2× and 7.4× its own source size on `gb_day`
alone while costing roughly the same to store. A count does not drift with a
[`chunk_strategy`](./documents.md) the caller picks, and it is also the figure
that says whether a project is a few large documents or a million tiny chunks —
two corpora that read alike on `gb_day` and behave nothing alike on search.

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
| `embedding` | An [embedding](./embeddings.md#metering) call — the endpoint, document ingestion, a memory write, or a search's query vector |

`source` is set by the platform at the metering choke point — a caller cannot bill eval spend as production. It both filters ([`GET /api/v1/usage/events?source=eval`](/docs/api/usage/list-usage-events)) and groups (`group_by=source`); ordinary traffic collapses into the `null` bucket, so groups still sum to the project total.

### Provider attribution

An event bills against the provider that served it: the target a [model route](./model-routes.md) picked for the turn, or the agent's pinned provider when it has one. The route's choice is read from what the turn actually did, so a generation that failed over meters against the target that answered rather than the one it abandoned. Because a routed agent pins nothing, this is also what keeps routed spend priced at all — an event with no provider resolves no price row and reports the `unknown` provider slug.

### End-user attribution

An event carries the [actor](./actors.md) and [session](./sessions.md) it was produced for, copied from the generation at write time and **frozen** — renaming or deleting either never rewrites recorded spend. Attribution is set on the session path only; direct agent generations, trigger-initiated work, orchestration nodes, and standalone completions record `null` for both. The actor is **derived from the session**, never taken from the request (`tool_context` is caller-writable and is not read for attribution). Events recorded before this shipped carry `null`.

There are three ways to read the resulting spend, in increasing order of how much shaping they let you do:

| Question | Read |
| --- | --- |
| What did this conversation cost? | The `usage` object on [`GET /api/v1/sessions/{session_id}`](/docs/api/sessions/get-session) — see [Session cost](./sessions.md#session-cost) |
| What has this end user cost, over a window or split by day/model? | [`GET /api/v1/usage/aggregate`](/docs/api/usage/get-usage-aggregate) with `actor_id=` (or `session_id=`), with or without a `group_by` |
| Which sessions or users are the biggest spenders? | The same endpoint with `group_by=session` or `group_by=actor` |
| Which turns made up that spend? | [`GET /api/v1/generations`](/docs/api/generations/list-generations) with `session_id=` or `actor_id=` |

`session_id` and `actor_id` are two of the [thirteen narrowings](#narrowing-a-rollup) the rollup takes; both narrow the **whole** rollup, so they compose with any `group_by`. `actor_id` is the figure behind an `actor`-scoped `cost_usd` [quota](./quotas.md#actor-scope): what the actor has spent, against the cap it is held to.

The same pair is on the generation record itself (`session_id`, `actor_id` on [`GET /api/v1/generations/{generation_id}`](/docs/api/generations/get-generation)), filters the generation listing, and filters the raw event listing (`?actor_id=` / `?session_id=` on [`GET /api/v1/usage/events`](/docs/api/usage/list-usage-events)), so a consumer that wants to price the turns itself can walk session → generation → components without recording the link on its own side.

### Pricing

Each component's cost is computed at write time from the effective price row for its `(provider, model, component)`, resolved most-specific first: AI provider instance → project + provider-slug → global default. Costs are frozen onto the components; later price changes never alter them. `cached_tokens` falls back to the `input_tokens` rate when no cached price is set. A `null` `cost_usd` means no price row covered the component — the quantity is still captured. Each component records `price_id`, so a receipt is auditable to the precise price applied.

**`cached_tokens` is a component in its own right, not a slice of `input_tokens`.** The `input_tokens` *component* holds uncached input only, and the two are priced independently — so pricing both is correct and double-counts nothing. What does include cached input is the reconstructed `input_tokens` *field* on a receipt's or an aggregate's totals, which is the provider's full prompt count (`input_tokens` component + `cached_tokens` component). Price the components; read the fields.

**Pricing is not retroactive.** Cost is frozen when the event is written, so a component metered before any row priced it stays `cost_usd: null` permanently — a project that sets its prices on day 30 can never cost its first 29 days, and there is no backfill or re-pricing pass. The [first-price exception](#pricing) exists for exactly this: while a `(provider, model, component)` is unpriced in every scope it resolves through, `effective_from` may be dated now or earlier, so the way to avoid the gap is to write the first row before the traffic rather than to correct it after. The quantities survive either way, so an unpriced window can still be costed outside the platform from the component counts.

**Embeddings are the one exception.** No tier prices an embedding call — it carries no provider record, and its rate is deployment configuration (`EMBEDDING_INPUT_1M_TOKEN_PRICE_USD`), so a price book row naming the embedding model is ignored. See [Pricing embeddings](./embeddings.md#pricing-embeddings).

SOAT ships **no default prices**. Prices are managed where their scope lives:

- **Global defaults** — admins via [`PUT /api/v1/usage/prices`](/docs/api/usage/upsert-price-book). [`GET /api/v1/usage/prices`](/docs/api/usage/get-price-book) lists only these.
- **Project + provider-slug** — project members via [`PUT /api/v1/projects/{project_id}/prices`](./projects.md).
- **Per-provider override** — project members via [`PUT /api/v1/ai-providers/{ai_provider_id}/prices`](./ai-providers.md#price-overrides).

Past-effective prices are immutable — corrections ship as new future-dated rows. A **first** price is the exception: when nothing prices a `(provider, model, component)` yet, in the scope being written or any broader one it resolves through, `effective_from` may be now or earlier. There is no row to rewrite and no cost frozen against one, and forcing a future date would leave the scope live and unpriced until it lands — a component metered in that window is charged `null` permanently, since cost is frozen when the event is written. Prices can also be **declared in a formation** with the `project_price` resource type, keyed on `(provider, model, component, effective_from)`; there `effective_from` is optional and defaults to deploy time. See [Formations Types → Project Price](/docs/formations-types/project-price).

Each `PUT` takes a batch and stops at the first row it refuses. Both refusals — an unparseable `effective_from`, and a now-or-past-dated write onto a `(provider, model, component)` that is already priced — return `400 VALIDATION_FAILED` with the failing row in `error.meta` as `provider`, `model`, `component` and `effective_from`. Read the row from there rather than from the message.

### Receipts and reconciliation

[`GET /api/v1/usage/receipt?generation_id=…`](/docs/api/usage/get-usage-receipt) returns a billing **receipt** for a completed generation: one line item per usage event, a `by_meter_type` cost split, reconstructed token totals (`input_tokens` is uncached input + cached), and a grand total. Because every component carries its price-book version and frozen cost, receipts are reproducible and meant to reconcile against the provider's invoice within a small tolerance (target ±2%).

[`GET /api/v1/usage/receipt?orchestration_run_id=…`](/docs/api/usage/get-usage-receipt) returns the same shape for an entire [orchestration](./orchestrations.md) run, summed across every node. The run's roll-up is also surfaced inline as a `usage` object on [`GET /api/v1/orchestration-runs/{orchestration_run_id}`](/docs/api/orchestrations/get-orchestration-run).

Every line item carries the `node_id` that produced it, so a run receipt is also the **per-node cost breakdown** — group the lines by `node_id` and each node's spend is the sum of its lines. Both meters appear under the node: an `agent` node's `llm_tokens` line and the `compute_execution` line of every node execution, so a pure node (a `transform`, a `condition`) shows up with its execution cost alone. Two things to know when reading it:

- **A retried node's attempts share one `node_id`.** Each attempt meters as its own event, so a retried node contributes one line per attempt; the event itself records no attempt number, so the lines group under a single `node_id`. That is the intended reading for spend — a retry is real money, so it belongs in the node's total.
- **A `null` `node_id`** means no node produced the event: a standalone generation on a per-generation receipt, or a run-level meter.

A run whose graph contains a `loop` or `sub_orchestration` node is covered by the receipt only for its **own** nodes: those nodes start child runs, whose events are attributed to the child, so the parent's receipt shows the starting node's execution cost and not what the children spent. That is deliberate — the line items carry a `node_id`, and merging a child's nodes in would mix node ids from two graphs under one list. The run's own `usage` field does span the subtree, so read that for the delegated total, `usage_own` for the run's own nodes, and the `parent_orchestration_run_id` filter for the children themselves; all three are described in [Run usage](./orchestrations.md#run-usage).

### Aggregation

[`GET /api/v1/usage/aggregate?project_id=…`](/docs/api/usage/get-usage-aggregate) rolls a project's usage up over an optional `[from, to]` window (inclusive ISO-8601 bounds on `created_at`), optionally bucketed by one dimension — `model`, `ai_provider`, `agent`, `orchestration_run`, `day`, `meter_type`, `actor`, `session`, or [`source`](#workload-source). `ai_provider` buckets on the provider the spend was billed against (see [Provider attribution](#provider-attribution)). Each group and the grand `totals` carry an `event_count`, summed token counts and `cost_usd` (`null` when no event in the bucket was priced). An event a dimension does not apply to collapses into a `null`-keyed group, so groups always sum to the project total. Requires `usage:GetAggregate` on the project.

**`group_by` is optional.** Omit it and `group_by` echoes back `null`, `groups` is an empty page, and `totals` still describes the whole window — which is what "what did this one agent cost" asks, without picking a bucketing to discard. A value naming no dimension is still a `400`.

#### Narrowing a rollup

Thirteen filters narrow the rollup before it is bucketed. They intersect, and each applies to the **whole** rollup — every bucket, `totals` and `totals.distinct` alike — so any of them composes with any `group_by`: `session_id` with `group_by=day` is one conversation's spend per day, the same `session_id` with `group_by=model` is that spend split by model.

| Filter | Selects |
| --- | --- |
| `session_id`, `actor_id` | One conversation, or one end user across every session ([End-user attribution](#end-user-attribution)) |
| `agent_id`, `ai_provider_id` | One agent's traffic; the spend billed against one provider record |
| `orchestration_run_id`, `orchestration_id` | One run; every run of one orchestration |
| `generation_id`, `trace_id` | One generation's events; everything recorded under one trace |
| `meter_type`, `model`, `source` | One meter, one as-billed SKU, one [workload source](#workload-source) |
| `trigger_id`, `action_id` | The spend one trigger initiated; one caller-supplied action label |

The two rows differ in how a value that matches nothing behaves. The **eight naming a resource** are resolved against the project first, and an id naming nothing there empties the rollup rather than dropping the filter — a mistyped id must never read back as the project's whole spend. The **five carrying a value** are matched exactly as the event recorded them, so an unrecognised meter, model or source simply selects no events; that is also why `trigger_id` and `action_id` are values rather than ids, since the event stores them denormalized and the spend outlives the trigger that incurred it.

`orchestration_id` selects the runs that orchestration started **itself**, never the subtree a `loop` or `sub_orchestration` node started under it — those are metered against the child orchestration, where they were incurred. That keeps the figure additive: summed across a project's orchestrations it reaches the project total exactly once. For one invocation's subtree, read `usage` on the run ([Run usage](./orchestrations.md#run-usage)).

Every narrowing is echoed back under `filters` on the response, `null` when unset, because a rollup of zeros is otherwise indistinguishable from a project that spent nothing. The same filters (plus `limit`/`offset`) narrow the raw event listing at [`GET /api/v1/usage/events`](/docs/api/usage/list-usage-events), so a rollup and the events behind it are addressed the same way.

**An unrecognised query parameter is a `400`** here as on every documented route, rather than being ignored. Ignoring one is not a missing answer but a wrong one: before `model` was a filter, `?group_by=day&model=…` returned the project-wide total under the caller's belief that it was one model's. The accepted names are listed in the error message.

The rollup is computed by the database — the window is grouped and summed in SQL, with one join for the chosen dimension — so the cost of a request tracks the buckets it answers with rather than the events behind them.

#### Counting entities

**`groups.total` counts buckets, not entities.** A dimension that does not apply to an event puts it in a `null`-keyed bucket, and that bucket is real: a project whose traffic is direct agent generations, eval items and trigger firings has exactly **one** `group_by=orchestration_run` bucket whether the window held ten events or a million. `actor`, `session`, `agent` and `source` each carry the same null bucket.

To count entities, send `include=distinct` and read `totals.distinct` — one `COUNT(DISTINCT …)` per attribution column on the event:

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

Nulls are not counted, which is the wanted reading throughout: a generation-less completion (`chat`, `memory_extraction`, `memory_consolidation`, `eval_judge`) moves `event_count` and nothing in `distinct`; a standalone generation counts under `generations` and not under `orchestration_runs`; a retried orchestration node — a second event and a second generation — counts once as a run.

Three things to know before relying on it:

- **It is opt-in because it costs.** Each key makes the database sort the window once more, so the default response keeps its cost whatever the event table grows to carry. A caller counting entities sends one request at `limit=1&include=distinct`; a caller walking pages for spend sends no `include` and pays nothing.
- **It is on `totals` only.** Groups never carry `distinct`: filling it per bucket would mean a `COUNT(DISTINCT)` per bucket on the page query.
- **These figures describe one window and none of them add.** Two adjacent windows' `distinct.sessions` overlap wherever a session spans the boundary, and a run that straddles midnight is in two `day` windows. A wider figure is a wider query, never a sum of narrower ones.

Any `include` value other than `distinct` is a `400`.

#### Paging the groups

`groups` is the standard paginated envelope (`data`, `total`, `limit`, `offset`), where `total` is the bucket count described above.

Two guarantees worth relying on:

- **`totals` and `groups.total` always describe the whole `[from, to]` window**, never the page above them. A page-scoped total read against an allowance would understate spend by however much the caller did not page through.
- **Groups are ordered by `cost_usd` descending**, ties broken by `key` then `ai_provider_id` ascending, nulls last. So the first page is the biggest spenders, and paging never repeats or skips a bucket — including in a window nothing has priced yet, where the key order is what keeps it deterministic.

`limit` defaults to 50 and is clamped to 100, as everywhere else in the API.

Every group also carries a `components` array — the measured dimensions summed over the bucket — so an infra meter aggregates to what it measured rather than reading as all-zero tokens. Entries are keyed by `component` **and** `unit` and sorted, and quantities are summed as exact decimals (no float drift).

For platform meter types `group_by=model` mixes model ids with SKUs; add `meter_type=llm_tokens` (or another meter type) to narrow to one meter. The applied filter is echoed back as `filters.meter_type` on the response; an unrecognized value yields an empty rollup rather than an error.

Under `group_by=model` every group also carries `ai_provider_id` — the [AI provider](./ai-providers.md) that served the bucket's model, `null` on every other dimension. A model id does not identify its provider on its own: one project can hold two providers serving byte-identical model names, so a consumer that presents its own model names cannot translate a bucket it cannot attribute. The model dimension therefore buckets on the model id **and** its provider, so one model name served by two providers is two groups repeating the same `key` with different `ai_provider_id`. The groups still sum to `totals`.

### Spend guards

Metered usage feeds the [guardrail](./guardrails.md) evaluator's `runtime.usage.*` context, so a spend limit is enforced deterministically at the tool boundary:

- **Per project, windowed** — `runtime.usage.cost_usd_{1h,24h,7d,30d}` and `runtime.usage.tokens_{24h,30d}`.
- **Per run, cumulative** — `runtime.usage.orchestration_run_tokens` and `runtime.usage.orchestration_run_cost_usd`; see [per-run spend ceilings](./guardrails.md#per-run-spend-ceilings).

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

Count the runs in a billing cycle without listing them — `totals.distinct` is
the answer (`groups.total` would count buckets, not runs), so `limit=1` keeps
the response small however many runs there were:

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
