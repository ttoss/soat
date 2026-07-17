---
description: "Meter an agent's token usage, price it, aggregate per-project spend, and get pushed a webhook alert when a budget threshold is crossed."
sidebar_position: 19
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Meter and Budget Your Project's Spend

Every time an agent completes a generation, SOAT records an append-only
[usage event](/docs/modules/usage) with the provider's reported token counts.
On top of that raw ledger you can price usage, roll it up per project, and get
**pushed** a webhook the moment a project crosses a budget. In this tutorial you
will:

1. Log in and create a project.
2. Create an Ollama-backed agent and run a generation.
3. Inspect the raw **usage meter** and its token components.
4. Read a **receipt** for the generation.
5. **Aggregate** the project's usage by day and by model.
6. Register **prices** so future usage carries a dollar cost.
7. Set a **budget threshold** and subscribe a webhook to the
   `usage.threshold_crossed` alert.

By the end you will understand SOAT's "meter now, price forward" model and how
to wire proactive budget alerts.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to
  bring the stack up with Docker Compose.
- [Ollama](https://ollama.com) running locally with a chat model available
  (this tutorial uses `qwen2.5:0.5b`).
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) first.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

All snippets below use a `SoatClient` created in Step 1.

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples)
for full authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Usage is metered and budgeted per [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Metering Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Metering Demo' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Metering Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an agent and run a generation

Set up a local Ollama [AI provider](/docs/modules/ai-providers#examples) and an
[agent](/docs/modules/agents#examples), then run one generation. The completed
generation is what SOAT meters.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Metered Agent" \
  --instructions "You are a concise assistant. Keep answers under 20 words." | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
GENERATION_ID=$(soat create-agent-generation \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Name three uses for a paperclip."}]' | jq -r '.id')
echo "GENERATION_ID: $GENERATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: provider.id,
    name: 'Metered Agent',
    instructions: 'You are a concise assistant. Keep answers under 20 words.',
  },
});

const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: agent.id },
  body: { messages: [{ role: 'user', content: 'Name three uses for a paperclip.' }] },
});
const GENERATION_ID = generation.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')
AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Metered Agent\",\"instructions\":\"You are a concise assistant. Keep answers under 20 words.\"}" | jq -r '.id')
GENERATION_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Name three uses for a paperclip."}]}' | jq -r '.id')
echo "GENERATION_ID: $GENERATION_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Inspect the raw usage meter

Each completed generation records one usage event whose **components** carry the
per-dimension token counts (`input_tokens`, `output_tokens`, `cached_tokens`,
and a non-billable `reasoning_tokens` detail). `cost_usd` is `null` for now —
you have not registered any prices yet, and SOAT ships none by default.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-usage-meters --generation-id "$GENERATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: meters } = await adminSoat.usage.listUsageMeters({
  query: { generation_id: GENERATION_ID },
});
console.log(meters.data);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/usage/meters?generation_id=$GENERATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

</TabItem>
</Tabs>

> The meter is written a moment after the generation response returns. If the
> list is empty, re-run the command.

---

## Step 5 — Read the generation receipt

A **receipt** rolls a generation's events into per-model line items with a
`by_meter_type` split and reconstructed token totals — the shape you reconcile
against a provider invoice. Pass `run_id` instead of `generation_id` to get the
same shape summed across an orchestration run.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage-receipt --generation-id "$GENERATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: receipt } = await adminSoat.usage.getUsageReceipt({
  query: { generation_id: GENERATION_ID },
});
console.log(receipt.total_input_tokens, receipt.total_output_tokens);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/usage/receipt?generation_id=$GENERATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

</TabItem>
</Tabs>

---

## Step 6 — Aggregate the project's usage

`get-usage` rolls the whole project up over an optional `[from, to]` window,
bucketed by one dimension: `model`, `agent`, `run`, `day`, or `meter_type`. This
is the per-project figure you would show on a dashboard — no client-side scan of
raw meter rows.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage --project-id "$PROJECT_ID" --group-by day
soat get-usage --project-id "$PROJECT_ID" --group-by model
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: byDay } = await adminSoat.usage.getUsage({
  query: { project_id: PROJECT_ID, group_by: 'day' },
});
const { data: byModel } = await adminSoat.usage.getUsage({
  query: { project_id: PROJECT_ID, group_by: 'model' },
});
console.log(byDay.totals, byModel.groups);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/usage?project_id=$PROJECT_ID&group_by=day" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
curl -s "$SOAT_URL/api/v1/usage?project_id=$PROJECT_ID&group_by=model" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

</TabItem>
</Tabs>

Each group and the grand `totals` carry summed token counts and `cost_usd`
(still `null` until you price the SKU next).

---

## Step 7 — Register prices (they apply going forward)

Cost is computed **at write time** from the price effective when a generation
runs, and prices are **immutable and non-retroactive** — `effective_from` must
be in the future, so a recorded cost is always explainable by the row that
produced it. Register a rate for the Ollama SKU; every generation from
`effective_from` onward will carry a `cost_usd`, while today's already-metered
usage stays frozen at `null`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat upsert-price-book \
  --prices '[{"provider":"ollama","model":"qwen2.5:0.5b","component":"input_tokens","unit":"token","unit_price":0.0000001,"effective_from":"2099-01-01T00:00:00.000Z"},{"provider":"ollama","model":"qwen2.5:0.5b","component":"output_tokens","unit":"token","unit_price":0.0000002,"effective_from":"2099-01-01T00:00:00.000Z"}]'
soat get-price-book
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.usage.upsertPriceBook({
  body: {
    prices: [
      { provider: 'ollama', model: 'qwen2.5:0.5b', component: 'input_tokens', unit: 'token', unit_price: 0.0000001, effective_from: '2099-01-01T00:00:00.000Z' },
      { provider: 'ollama', model: 'qwen2.5:0.5b', component: 'output_tokens', unit: 'token', unit_price: 0.0000002, effective_from: '2099-01-01T00:00:00.000Z' },
    ],
  },
});
const { data: prices } = await adminSoat.usage.getPriceBook();
console.log(prices.prices);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_URL/api/v1/usage/prices" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"prices":[{"provider":"ollama","model":"qwen2.5:0.5b","component":"input_tokens","unit":"token","unit_price":0.0000001,"effective_from":"2099-01-01T00:00:00.000Z"},{"provider":"ollama","model":"qwen2.5:0.5b","component":"output_tokens","unit":"token","unit_price":0.0000002,"effective_from":"2099-01-01T00:00:00.000Z"}]}'
curl -s "$SOAT_URL/api/v1/usage/prices" -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

</TabItem>
</Tabs>

> Prices resolve most-specific-first: a per-provider override, then a
> project + provider-slug rate, then this global default. See
> [Usage → Pricing](/docs/modules/usage) for the full resolution rules.

---

## Step 8 — Set a budget threshold and subscribe to the alert

A [`UsageThreshold`](/docs/modules/usage#usagethreshold) fires the
`usage.threshold_crossed` [webhook](/docs/modules/webhooks) after any
usage-event write once a project's windowed metric crosses it. Because **tokens
are always metered** (with or without prices), a `tokens` threshold works
immediately; a `cost_usd` threshold starts counting as priced usage accrues.

Create both, then subscribe a webhook so the alert is pushed to you.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-usage-threshold \
  --project-id "$PROJECT_ID" \
  --metric tokens \
  --window rolling_24h \
  --threshold 1
soat create-usage-threshold \
  --project-id "$PROJECT_ID" \
  --metric cost_usd \
  --window calendar_month \
  --threshold 50
soat create-webhook \
  --project-id "$PROJECT_ID" \
  --name "budget-alerts" \
  --url "https://example.com/usage-alerts" \
  --events '["usage.threshold_crossed"]'
soat list-usage-thresholds --project-id "$PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.usage.createUsageThreshold({
  body: { project_id: PROJECT_ID, metric: 'tokens', window: 'rolling_24h', threshold: 1 },
});
await adminSoat.usage.createUsageThreshold({
  body: { project_id: PROJECT_ID, metric: 'cost_usd', window: 'calendar_month', threshold: 50 },
});
await adminSoat.webhooks.createWebhook({
  body: {
    project_id: PROJECT_ID,
    name: 'budget-alerts',
    url: 'https://example.com/usage-alerts',
    events: ['usage.threshold_crossed'],
  },
});
const { data: thresholds } = await adminSoat.usage.listUsageThresholds({
  query: { project_id: PROJECT_ID },
});
console.log(thresholds.data);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/usage/thresholds" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"metric\":\"tokens\",\"window\":\"rolling_24h\",\"threshold\":1}"
curl -s -X POST "$SOAT_URL/api/v1/usage/thresholds" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"metric\":\"cost_usd\",\"window\":\"calendar_month\",\"threshold\":50}"
curl -s -X POST "$SOAT_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"budget-alerts\",\"url\":\"https://example.com/usage-alerts\",\"events\":[\"usage.threshold_crossed\"]}"
curl -s "$SOAT_URL/api/v1/usage/thresholds?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

</TabItem>
</Tabs>

The `tokens`/`rolling_24h` threshold above (limit `1`) is already exceeded by
Step 3's generation, so the **next** metered generation on this project fires
the webhook. Delivery carries the standard signed envelope with this `data`:

```json
{
  "threshold_id": "uthr_V1StGXR8Z5jdHi6B",
  "project_id": "proj_V1StGXR8Z5jdHi6B",
  "metric": "tokens",
  "window": "rolling_24h",
  "window_key": null,
  "threshold": 1,
  "observed_value": 62
}
```

Re-fire is bounded by hysteresis so you are not spammed:

- **`calendar_month`** fires at most once per `YYYY-MM` window (`window_key`
  identifies it); it re-arms at the month boundary.
- **`rolling_24h`** re-arms only after the windowed value drops below 90% of the
  threshold (`window_key` is `null`).

Thresholds are immutable apart from deletion — to change one, delete and
recreate it, which resets its fire state.

---

## What you learned

- Every completed generation is metered into an append-only usage event with
  per-dimension token **components**; `cost_usd` is `null` until a price covers
  the SKU.
- **Receipts** reconcile a generation (or a whole run) against a provider
  invoice; **`get-usage`** rolls a project up by model/agent/run/day/meter type.
- Prices are **write-time and forward-only** — you register rates that apply to
  future usage, and historical costs never change.
- **Thresholds** push a `usage.threshold_crossed` webhook when a project crosses
  a token or cost budget, with once-per-window / 10% re-arm hysteresis.

See the [Usage module](/docs/modules/usage) for the full data model, pricing
tiers, and permissions.
