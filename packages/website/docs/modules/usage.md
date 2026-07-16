---
description: "Usage meters record the token cost of every LLM generation, attributing spend to a project, agent, and generation."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Usage

Usage meters record the token cost of every LLM generation, so spend can be attributed to a project, agent, and generation.

## Overview

Whenever an agent completes a generation, SOAT records one **usage-meter row** from the token counts the provider reports for that call: input, output, cached, and reasoning tokens. Rows are written at the single point every agent completion flows through, so adding a provider cannot silently skip metering.

Meter rows are **append-only and immutable** — there is no update or delete path and no `updated_at` — so historical usage never changes after the fact. Writes are **idempotent** on the generation's public ID: a replayed completion upserts into a no-op instead of double counting.

Every meter row links back to the resources it attributes spend to: the [generation](./generations.md) that produced the call and its [agent](./agents.md), the [trace](./traces.md) it belongs to, the [AI provider](./ai-providers.md) instance billed, the [project](./projects.md) it rolls up to, and — when applicable — the [trigger](./triggers.md) or [orchestration](./orchestrations.md) run that initiated it.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### UsageMeter

| Field              | Type            | Description                                                                                  |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `id`               | string          | Public identifier for the meter row (`um_` prefix)                                           |
| `project_id`       | string          | Project the usage is attributed to                                                           |
| `run_id`           | string \| null  | Orchestration run that initiated the call, when the generation ran inside a run              |
| `node_id`          | string \| null  | Orchestration node within the run, when applicable                                           |
| `agent_id`         | string \| null  | Agent that ran the generation                                                                |
| `generation_id`    | string \| null  | Generation this usage was recorded for                                                       |
| `trace_id`         | string \| null  | Trace this usage belongs to (reconcile against the trace tree)                               |
| `ai_provider_id`   | string \| null  | AI provider instance billed; correlates the meter to the price book                          |
| `trigger_id`       | string \| null  | Trigger that initiated the generation (agent-target triggers); null otherwise                |
| `action_id`        | string \| null  | Caller-supplied logical action label, for rolling spend up per action                        |
| `meter_type`       | string          | What the row measures: `llm_tokens` (default), `node_execution`, `api_request`, or `storage` |
| `provider`         | string          | Denormalized as-billed provider slug (e.g. `openai`); `soat` for platform meter types        |
| `model`            | string          | Model identifier the provider billed; the billable SKU for platform meter types              |
| `input_tokens`     | number          | Input (prompt) tokens reported by the provider (`llm_tokens` rows; `0` otherwise)            |
| `output_tokens`    | number          | Output (completion) tokens reported by the provider (`llm_tokens` rows; `0` otherwise)       |
| `cached_tokens`    | number          | Cached input tokens read, when the provider reports them (else `0`)                          |
| `reasoning_tokens` | number          | Reasoning tokens the provider reports separately (else `0`)                                  |
| `quantity`         | number \| null  | Generic measure for non-`llm_tokens` types (node-seconds, requests, GB-days); `null` for token rows |
| `unit`             | string \| null  | Unit `quantity` is measured in (`node_second` \| `request` \| `gb_day`); `null` for token rows |
| `cost_usd`         | number \| null  | Cost in USD computed at write time from the price book; `null` when no price row covers the model |
| `price_id`         | string \| null  | Price-book row that produced `cost_usd` (the price-table version); `null` when unpriced       |
| `created_at`       | string          | ISO 8601 creation timestamp                                                                  |

### PriceBook

Versioned unit prices used to compute `cost_usd`, in **three scopes** within one table, resolved most-specific first. A **per-provider override** (`ai_provider_id` set) prices one specific [AI provider](./ai-providers.md) instance — e.g. an enterprise-negotiated rate or a gateway with markup. A **project + provider-slug** price (`project_id` set, `ai_provider_id` null) covers every one of a [project](./projects.md)'s instances of a slug. A **global default** (both null) is keyed by `(provider, model, effective_from)`. Cost lookup prefers instance → project+slug → global; within each scope the latest `effective_from <= now()` applies.

| Field                | Type            | Description                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `id`                 | string          | Public identifier for the price row (`price_` prefix)              |
| `ai_provider_id`     | string \| null  | Set for a per-provider override; `null` otherwise                   |
| `project_id`         | string \| null  | Set for a project + provider-slug price; `null` otherwise           |
| `meter_type`         | string          | Meter type this price applies to; `llm_tokens` (default) uses the token rates, others use `unit_price` |
| `provider`           | string          | AI provider slug (e.g. `openai`); `soat` for platform SKUs         |
| `model`              | string          | Model identifier, or the billable SKU for platform meter types    |
| `input_price_per_m`  | number \| null  | USD per one million input (prompt) tokens; `null` on non-LLM rows   |
| `output_price_per_m` | number \| null  | USD per one million output (completion) tokens; `null` on non-LLM rows |
| `cached_price_per_m` | number \| null  | USD per one million cached input tokens; `null` falls back to input |
| `unit_price`         | number \| null  | USD per `unit` on non-`llm_tokens` rows; `null` on token rows        |
| `unit`               | string \| null  | Unit `unit_price` is denominated in (e.g. `node_second`); `null` on token rows |
| `effective_from`     | string          | ISO 8601; the latest row `<= now()` prices a call                  |
| `created_at`         | string          | ISO 8601 creation timestamp                                        |

## Key Concepts

### Meter types

Every meter row carries a `meter_type` discriminator so cost dimensions beyond LLM tokens share one metering pipeline (attribution chain, append-only/idempotency guarantees, write-time pricing, and aggregation) rather than forking a table per dimension.

| `meter_type`     | What one row records                                | Measure                          |
| ---------------- | --------------------------------------------------- | -------------------------------- |
| `llm_tokens`     | One completed LLM call's token usage (today's rows) | token columns; `quantity` `null` |
| `node_execution` | One orchestration node's wall-clock compute time    | `quantity` seconds / `node_second` |
| `api_request`    | A batch of API requests served for a project        | `quantity` requests / `request`  |
| `storage`        | One project's stored bytes for one day              | `quantity` GB-days / `gb_day`    |

`llm_tokens` rows use the four token columns and leave `quantity`/`unit` null; every other type records its measure in `quantity`/`unit` and leaves the token columns at `0` — the same number is never double-encoded. For platform meter types the `(provider, model)` pair is a **SKU**: `provider` is `soat` and `model` names the billable unit (e.g. `node-second`). Emitters for the non-LLM types are added in later milestones; the schema and pricing carry `meter_type` now so those become emitter-only work.

### Token breakdown

Each row separates the provider's token report into four counts. `cached_tokens` and `reasoning_tokens` are recorded only when the provider reports them (e.g. OpenAI's `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`); a provider that omits a breakdown records `0`, never `null`, so the counts stay summable.

### Coverage

Usage is metered for agent generations — including [conversations](./conversations.md) and [orchestration](./orchestrations.md) agent nodes, which run through the same agent-completion path. `run_id` and `node_id` are reserved for orchestration attribution and are `null` for standalone generations.

### Trigger and action attribution

`action_id` is a caller-supplied label passed on the generate request (`action_id`), persisted on the [generation](./generations.md) and copied onto its meter so spend can be rolled up per logical action independent of the agent or generation. `trigger_id` is set automatically when an **agent-target** [trigger](./triggers.md) initiates the generation. Filter the raw meter list by either (`?trigger_id=` / `?action_id=`) to roll usage up by trigger or action. (Trigger attribution for generations produced inside an [orchestration](./orchestrations.md) run is tracked with the run-scoping work and is `null` until then.)

### Pricing

`cost_usd` is computed at write time from the effective price row for the meter's `(provider, model)`, resolved most-specific first: the AI provider instance → the project's rate for that slug → the global default. Cost is frozen onto the meter, so later price changes never alter it — swapping a model changes new-run cost while historical receipts stay put. Computation branches on meter type: `llm_tokens` uses the per-million token formula (cached input billed at `cached_price_per_m`, falling back to the input rate; reasoning tokens are part of the output count), while every other type is `quantity × unit_price`. `cost_usd` is `null` only when no price row covers the SKU — the tokens or quantity are still captured, it does not mean the call was free.

A price row must match its `meter_type`'s shape: `llm_tokens` rows require `input_price_per_m` and `output_price_per_m` and must omit `unit_price`/`unit`; other meter types require `unit_price` and `unit` and must omit the token rates. Upserts that mix the two shapes are rejected with `400`.

Each meter records `price_id` — the exact price-book row that produced its `cost_usd`. Because cost is frozen and the price row is versioned, a receipt is auditable to the precise price applied even after prices change.

SOAT ships **no default prices** — until an operator adds a price row, cost is computed as `null` (tokens are still captured) rather than from indicative, potentially stale rates. Prices are managed where their scope lives:

- **Global defaults** — admins via `PUT /api/v1/usage/prices`. `GET /api/v1/usage/prices` lists only these, so no project sees another's rates.
- **Project + provider-slug** — project members via [`PUT /api/v1/projects/{project_id}/prices`](./projects.md), pricing all of a project's instances of a slug at once.
- **Per-provider override** — project members via [`PUT /api/v1/ai-providers/{ai_provider_id}/prices`](./ai-providers.md#price-overrides), pricing one instance.

Past-effective prices are immutable — corrections ship as new future-dated rows.

### Receipts and reconciliation

`GET /api/v1/usage/receipt?generation_id=…` returns a billing **receipt** for a completed generation: per-model line items (tokens in/out, the `price_id` version that priced them, and cost), a `by_meter_type` breakdown (the "tokens + infra" split — one entry per distinct meter type, each with its own token/quantity/cost totals), plus grand totals. A single-type receipt has one `by_meter_type` entry whose totals equal the receipt totals. Because every line carries the exact price-book version and the cost is frozen at write time, receipts stay reproducible and are meant to reconcile against the provider's invoice within a small tolerance (target ±2%); investigate any project whose summed receipts drift beyond it. Per-**run** receipts (summing a run's generations) follow once run-scoping lands.

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
