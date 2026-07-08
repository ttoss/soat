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
| `provider`         | string          | Denormalized as-billed provider slug (e.g. `openai`), retained if the provider is deleted    |
| `model`            | string          | Model identifier the provider billed                                                         |
| `input_tokens`     | number          | Input (prompt) tokens reported by the provider                                               |
| `output_tokens`    | number          | Output (completion) tokens reported by the provider                                          |
| `cached_tokens`    | number          | Cached input tokens read, when the provider reports them (else `0`)                          |
| `reasoning_tokens` | number          | Reasoning tokens the provider reports separately (else `0`)                                  |
| `cost_usd`         | number \| null  | Cost in USD computed at write time from the price book; `null` when no price row covers the model |
| `price_id`         | string \| null  | Price-book row that produced `cost_usd` (the price-table version); `null` when unpriced       |
| `created_at`       | string          | ISO 8601 creation timestamp                                                                  |

### PriceBook

Versioned unit prices used to compute `cost_usd`, in two scopes within one table. A **global default** (`ai_provider_id: null`) is keyed by `(provider, model, effective_from)`; an optional **per-provider override** (`ai_provider_id` set) prices a specific [AI provider](./ai-providers.md) instance — e.g. an enterprise-negotiated rate or a gateway with markup. Cost lookup prefers the override, then falls back to the global default; within each scope the latest `effective_from <= now()` applies.

| Field                | Type            | Description                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `id`                 | string          | Public identifier for the price row (`price_` prefix)              |
| `ai_provider_id`     | string \| null  | `null` for a global default; set for a per-provider override        |
| `provider`           | string          | AI provider slug (e.g. `openai`)                                   |
| `model`              | string          | Model identifier                                                   |
| `input_price_per_m`  | number          | USD per one million input (prompt) tokens                          |
| `output_price_per_m` | number          | USD per one million output (completion) tokens                     |
| `cached_price_per_m` | number \| null  | USD per one million cached input tokens; `null` falls back to input |
| `effective_from`     | string          | ISO 8601; the latest row `<= now()` prices a call                  |
| `created_at`         | string          | ISO 8601 creation timestamp                                        |

## Key Concepts

### Token breakdown

Each row separates the provider's token report into four counts. `cached_tokens` and `reasoning_tokens` are recorded only when the provider reports them (e.g. OpenAI's `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`); a provider that omits a breakdown records `0`, never `null`, so the counts stay summable.

### Coverage

Usage is metered for agent generations — including [conversations](./conversations.md) and [orchestration](./orchestrations.md) agent nodes, which run through the same agent-completion path. `run_id` and `node_id` are reserved for orchestration attribution and are `null` for standalone generations.

### Trigger and action attribution

`action_id` is a caller-supplied label passed on the generate request (`action_id`), persisted on the [generation](./generations.md) and copied onto its meter so spend can be rolled up per logical action independent of the agent or generation. `trigger_id` is set automatically when an **agent-target** [trigger](./triggers.md) initiates the generation. Filter the raw meter list by either (`?trigger_id=` / `?action_id=`) to roll usage up by trigger or action. (Trigger attribution for generations produced inside an [orchestration](./orchestrations.md) run is tracked with the run-scoping work and is `null` until then.)

### Pricing

`cost_usd` is computed at write time from the price book: the row for the meter's `(provider, model)` whose `effective_from <= now()`. Cost is frozen onto the meter, so later price changes never alter it — swapping a model changes new-run cost while historical receipts stay put. Cached input tokens are billed at `cached_price_per_m` (falling back to the input rate); reasoning tokens are part of the output count. `cost_usd` is `null` only when no price row covers the model — the tokens are still captured, it does not mean the call was free.

Each meter records `price_id` — the exact price-book row that produced its `cost_usd`. Because cost is frozen and the price row is versioned, a receipt is auditable to the precise price applied even after prices change.

SOAT ships **global default prices** for common provider/model pairs (seeded at startup) so cost is computed out of the box. Admins add or correct prices with future-dated rows via `PUT /api/v1/usage/prices` (include `ai_provider_id` to record a **per-provider override** instead of a global default). Past-effective prices are immutable — corrections ship as new future-dated rows. `GET /api/v1/usage/prices` returns the global defaults; per-provider overrides are not listed there, to avoid exposing one project's negotiated rates to another.

### Receipts and reconciliation

`GET /api/v1/usage/receipt?generation_id=…` returns a billing **receipt** for a completed generation: per-model line items (tokens in/out, the `price_id` version that priced them, and cost) plus totals. Because every line carries the exact price-book version and the cost is frozen at write time, receipts stay reproducible and are meant to reconcile against the provider's invoice within a small tolerance (target ±2%); investigate any project whose summed receipts drift beyond it. Per-**run** receipts (summing a run's generations) follow once run-scoping lands.

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
