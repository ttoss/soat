import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Usage

Usage meters record the token cost of every LLM generation, so spend can be attributed to a project, agent, and generation.

## Overview

Whenever an agent completes a generation, SOAT records one **usage-meter row** from the token counts the provider reports for that call: input, output, cached, and reasoning tokens. Rows are written at the single point every agent completion flows through, so adding a provider cannot silently skip metering.

Meter rows are **append-only and immutable** — there is no update or delete path and no `updated_at` — so historical usage never changes after the fact. Writes are **idempotent** on the generation's public ID: a replayed completion upserts into a no-op instead of double counting.

Usage relates to [generations](./generations.md) (each row links back to the generation that produced it) and [agents](./agents.md) (the agent billed for the call).

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
| `cost_usd`         | number \| null  | Cost in USD computed at write time from the price book; `null` when tokens are not yet priced |
| `created_at`       | string          | ISO 8601 creation timestamp                                                                  |

## Key Concepts

### Token breakdown

Each row separates the provider's token report into four counts. `cached_tokens` and `reasoning_tokens` are recorded only when the provider reports them (e.g. OpenAI's `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`); a provider that omits a breakdown records `0`, never `null`, so the counts stay summable.

### Coverage

Usage is metered for agent generations — including conversations and orchestration agent nodes, which run through the same agent-completion path. `run_id` and `node_id` are reserved for orchestration attribution and are `null` for standalone generations.

### Trigger and action attribution

`action_id` is a caller-supplied label passed on the generate request (`action_id`), persisted on the generation and copied onto its meter so spend can be rolled up per logical action independent of the agent or generation. `trigger_id` is set automatically when an **agent-target** trigger initiates the generation. Filter the raw meter list by either (`?trigger_id=` / `?action_id=`) to roll usage up by trigger or action. (Trigger attribution for generations produced inside an orchestration run is tracked with the run-scoping work and is `null` until then.)

### Pricing

`cost_usd` is `null` until a versioned price book prices the captured tokens. A `null` cost means "tokens captured, not yet priced" — it does not mean the call was free. Pricing correlates through `ai_provider_id` (the specific provider instance billed), so two providers that share a slug but differ in configuration can be priced independently. The denormalized `provider`/`model` snapshot keeps the receipt accurate even if the provider is later deleted (`ai_provider_id` → `null`).

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
