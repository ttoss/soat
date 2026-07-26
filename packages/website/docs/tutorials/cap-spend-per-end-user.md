---
description: "Attribute agent spend to individual end users with Actors, then cap each user's monthly budget with one actor-scoped quota."
sidebar_position: 21
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Cap Spend Per End User

A per-user product needs a per-user budget: _"no single user costs me more than X a month"_, enforced no matter which agent they talk to. SOAT gets there in two moves — [Actors](/docs/modules/actors) give each end user an identity that [usage events](/docs/modules/usage) are billed to, and one actor-scoped [Quota](/docs/modules/quotas) turns that ledger into a hard cap.

You will:

1. Create an agent, then two [actors](/docs/modules/actors) standing in for two end users.
2. Bind a [session](/docs/modules/sessions) to an actor and run a turn — the session path is what makes attribution possible.
3. Read spend **per end user** out of the usage meter.
4. Cap every end user with a **single** quota, and watch one user get blocked with `429` while the other keeps working.
5. Raise the cap, and see the blocked user resume.
6. Discover the one case where a cost cap silently protects nothing — and the [exception](/docs/modules/exceptions) the platform files about it.
7. Switch a quota to **monitor** mode to observe a breach without blocking it.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` available. This tutorial uses a local provider so it runs without external credentials — to connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and sessions first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Server is at `http://localhost:5047`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for authentication details.

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
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Quotas are always project-scoped, so the [project](/docs/modules/projects#examples) is the tenant boundary for every cap in this tutorial.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Per-User Spend" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Per-User Spend' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Per-User Spend"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the provider and agent

A local Ollama [AI provider](/docs/modules/ai-providers#examples) and one [agent](/docs/modules/agents#examples) that both end users will talk to. The instructions keep answers short so the token counts in this tutorial stay small and legible.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Bot" \
  --instructions "You are a concise assistant. Answer in one short sentence." | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
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
    name: 'Support Bot',
    instructions: 'You are a concise assistant. Answer in one short sentence.',
  },
});
const AGENT_ID = agent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Bot\",\"instructions\":\"You are a concise assistant. Answer in one short sentence.\"}" | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create an actor per end user

An [Actor](/docs/modules/actors) is the platform's identity for someone outside it — a customer, a WhatsApp contact, a signed-in app user. `external_id` is how you correlate it with your own system, and creation with an `external_id` is **idempotent**: posting the same one again returns the existing actor (`200` instead of `201`) rather than creating a duplicate. That is what lets an inbound-message webhook call `create-actor` on every message without bookkeeping.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADA_ID=$(soat create-actor --project-id "$PROJECT_ID" \
  --name "Ada" --external-id "+15551230001" | jq -r '.id')
BLAKE_ID=$(soat create-actor --project-id "$PROJECT_ID" \
  --name "Blake" --external-id "+15551230002" | jq -r '.id')
echo "ADA_ID: $ADA_ID"
echo "BLAKE_ID: $BLAKE_ID"
```

Post Ada again and you get the same actor back, not a second one:

```bash
soat create-actor --project-id "$PROJECT_ID" \
  --name "Ada" --external-id "+15551230001" | jq -r '.id'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: ada } = await adminSoat.actors.createActor({
  body: { project_id: PROJECT_ID, name: 'Ada', external_id: '+15551230001' },
});
const { data: blake } = await adminSoat.actors.createActor({
  body: { project_id: PROJECT_ID, name: 'Blake', external_id: '+15551230002' },
});

// Idempotent: same external_id returns the same actor.
const { data: again } = await adminSoat.actors.createActor({
  body: { project_id: PROJECT_ID, name: 'Ada', external_id: '+15551230001' },
});
console.log(again.id === ada.id); // true
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/actors" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Ada\",\"external_id\":\"+15551230001\"}" | jq -r '.id')

BLAKE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/actors" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Blake\",\"external_id\":\"+15551230002\"}" | jq -r '.id')
echo "ADA_ID: $ADA_ID"
echo "BLAKE_ID: $BLAKE_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Run a turn through a session bound to the actor

Attribution is set on the [session](/docs/modules/sessions) path, because a session is the surface that knows which end user a turn belongs to. Create the session with `actor_id`, add a user message, and generate.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADA_SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" \
  --actor-id "$ADA_ID" --name "Ada session" | jq -r '.id')

soat add-session-message --session-id "$ADA_SESSION_ID" \
  --message "Name one use for a paperclip."
soat generate-session-response --session-id "$ADA_SESSION_ID" | jq '{status}'
```

Expected output (the assistant's wording will vary — only the status matters):

```json
{ "status": "completed" }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: adaSession } = await adminSoat.sessions.createSession({
  body: { agent_id: AGENT_ID, actor_id: ada.id, name: 'Ada session' },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: adaSession.id },
  body: { message: 'Name one use for a paperclip.' },
});

const { data: turn } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: adaSession.id },
  body: {},
});
console.log(turn.status); // completed
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADA_SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"actor_id\":\"$ADA_ID\",\"name\":\"Ada session\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Name one use for a paperclip."}' > /dev/null

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq '{status}'
```

</TabItem>
</Tabs>

:::note
Only the session path carries an end user. A direct agent generation, a [trigger](/docs/modules/triggers)-initiated run, and an [orchestration](/docs/modules/orchestrations) node have nobody behind them and record `null` for both `actor_id` and `session_id` — so they match no actor quota. Cap that traffic with a `project`- or `agent`-scoped quota instead.
:::

---

## Step 6 — Read spend per end user

The [usage meter](/docs/modules/usage#end-user-attribution) copies the actor and session onto every event at write time and **freezes** them there. Renaming an actor or deleting a session never rewrites recorded spend.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-usage --project-id "$PROJECT_ID" --group-by actor | jq '{groups, totals}'
```

Expected output — one bucket per end user:

```json
{
  "groups": [
    {
      "key": "actor_...",
      "cost_usd": null,
      "input_tokens": 36,
      "output_tokens": 14,
      "cached_tokens": 0,
      "reasoning_tokens": 0
    }
  ],
  "totals": {
    "cost_usd": null,
    "input_tokens": 36,
    "output_tokens": 14,
    "cached_tokens": 0,
    "reasoning_tokens": 0
  }
}
```

The raw event carries the full attribution chain, filterable by actor:

```bash
soat list-usage-meters --actor-id "$ADA_ID" \
  | jq '.data[0] | {meter_type, model, actor_id, session_id, agent_id, cost_usd, components}'
```

```json
{
  "meter_type": "llm_tokens",
  "model": "qwen2.5:0.5b",
  "actor_id": "actor_...",
  "session_id": "sess_...",
  "agent_id": "agent_...",
  "cost_usd": null,
  "components": [
    { "component": "input_tokens", "quantity": 36, "unit": "token", "billable": true },
    { "component": "output_tokens", "quantity": 14, "unit": "token", "billable": true }
  ]
}
```

`cost_usd` is `null` because this project has no [price book](/docs/modules/usage#pricing) yet — the tokens are recorded, they just are not priced. Step 9 shows why that matters for cost caps.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: byActor } = await adminSoat.usage.getUsage({
  params: { query: { project_id: PROJECT_ID, group_by: 'actor' } },
});
console.log(byActor.groups);

const { data: meters } = await adminSoat.usage.listUsageMeters({
  params: { query: { actor_id: ada.id } },
});
console.log(meters.data[0].actor_id, meters.data[0].components);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/usage?project_id=$PROJECT_ID&group_by=actor" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{groups, totals}'

curl -s "$SOAT_BASE_URL/api/v1/usage/meters?actor_id=$ADA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[0] | {meter_type, actor_id, session_id, components}'
```

</TabItem>
</Tabs>

---

## Step 7 — One quota, one budget per end user

Here is the part worth reading twice. For `actor` scope, a **null `scope_ref` means one budget per actor** — not one pooled total shared across all of them. So a single quota expresses _"every end user gets N tokens a month"_, and one user exhausting theirs never blocks anyone else.

The limit below is deliberately tiny (30 tokens) so that the single short turn from Step 5 already crosses it — the prompt alone costs more than that in input tokens. In production this would be `100000` or more.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
QUOTA_ID=$(soat create-quota --project-id "$PROJECT_ID" \
  --scope actor --metric tokens --window calendar_month --limit 30 | jq -r '.id')
soat get-quota --quota-id "$QUOTA_ID" \
  | jq '{scope, scope_ref, metric, window, limit, mode}'
```

Expected output:

```json
{
  "scope": "actor",
  "scope_ref": null,
  "metric": "tokens",
  "window": "calendar_month",
  "limit": 30,
  "mode": "enforce"
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: quota } = await adminSoat.quotas.createQuota({
  body: {
    project_id: PROJECT_ID,
    scope: 'actor',
    metric: 'tokens',
    window: 'calendar_month',
    limit: 30,
  },
});
console.log(quota.scope, quota.scope_ref, quota.mode); // actor null enforce
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
QUOTA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/quotas" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"scope\":\"actor\",\"metric\":\"tokens\",\"window\":\"calendar_month\",\"limit\":30}" \
  | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/quotas/$QUOTA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{scope, scope_ref, metric, window, limit, mode}'
```

</TabItem>
</Tabs>

:::note
`current_usage` reads `null` on a `tokens` or `cost_usd` quota. Those metrics aggregate the [usage meter](/docs/modules/usage) directly at check time rather than keeping a separate counter, which is why a quota and the usage report can never disagree. Only the `requests` metric keeps a window counter.
:::

A quota is also only accepted for a scope its metric can actually be aggregated by. `requests` is counted by the request middleware, which sees the API key but not the end user behind the call — so `actor` + `requests` is rejected outright rather than stored as a silent no-op:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat create-quota --project-id "$PROJECT_ID" --scope actor --metric requests --window rolling_1h --limit 10
```

```json
{
  "status": 400,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "scope \"actor\" is not valid for metric \"requests\"."
  }
}
```

See [Scope × metric validity](/docs/modules/quotas#scope--metric-validity) for the full table.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await adminSoat.quotas.createQuota({
  body: {
    project_id: PROJECT_ID,
    scope: 'actor',
    metric: 'requests',
    window: 'rolling_1h',
    limit: 10,
  },
});
console.log(error); // 400 — scope "actor" is not valid for metric "requests".
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/quotas" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"scope\":\"actor\",\"metric\":\"requests\",\"window\":\"rolling_1h\",\"limit\":10}" \
  | jq '{error}'
```

</TabItem>
</Tabs>

---

## Step 8 — One user is blocked, the other is not

Ada's Step 5 turn already put her over the 30-token cap, so her next turn is refused **before the generation starts** with `429 QUOTA_EXCEEDED` — nothing is metered for a blocked call.

Blake, under the very same quota, is at zero. His first turn runs normally. That is the per-actor budget doing its job.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat add-session-message --session-id "$ADA_SESSION_ID" --message "And another use?"
```

```bash
# → expect-fail
soat generate-session-response --session-id "$ADA_SESSION_ID"
```

Expected output — the error carries the quota that fired and when the window resets:

```json
{
  "status": 429,
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Quota exceeded for actor.",
    "meta": {
      "quota_id": "quota_...",
      "metric": "tokens",
      "limit": 30,
      "window": "calendar_month",
      "resets_at": "2026-08-01T00:00:00.000Z"
    }
  }
}
```

Now Blake, against the same quota:

```bash
BLAKE_SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" \
  --actor-id "$BLAKE_ID" --name "Blake session" | jq -r '.id')
soat add-session-message --session-id "$BLAKE_SESSION_ID" \
  --message "Name one use for a rubber band."
soat generate-session-response --session-id "$BLAKE_SESSION_ID" | jq '{status}'
soat get-usage --project-id "$PROJECT_ID" --group-by actor | jq '.groups'
```

```json
{ "status": "completed" }
```

Both users now appear as separate buckets — Ada capped, Blake spending:

```json
[
  { "key": "actor_...", "input_tokens": 36, "output_tokens": 14, "cost_usd": null },
  { "key": "actor_...", "input_tokens": 36, "output_tokens": 20, "cost_usd": null }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.sessions.addSessionMessage({
  path: { session_id: adaSession.id },
  body: { message: 'And another use?' },
});

const { error } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: adaSession.id },
  body: {},
});
console.log(error.error.code, error.error.meta.resets_at); // QUOTA_EXCEEDED ...

const { data: blakeSession } = await adminSoat.sessions.createSession({
  body: { agent_id: AGENT_ID, actor_id: blake.id, name: 'Blake session' },
});
await adminSoat.sessions.addSessionMessage({
  path: { session_id: blakeSession.id },
  body: { message: 'Name one use for a rubber band.' },
});
const { data: blakeTurn } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: blakeSession.id },
  body: {},
});
console.log(blakeTurn.status); // completed — a separate budget
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"And another use?"}' > /dev/null

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq '{error}'

BLAKE_SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"actor_id\":\"$BLAKE_ID\",\"name\":\"Blake session\"}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$BLAKE_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Name one use for a rubber band."}' > /dev/null

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$BLAKE_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq '{status}'
```

</TabItem>
</Tabs>

:::note
A generation already **in flight is never killed** — its tokens are spent and will be billed — so a budget can overshoot by at most one generation. That is why Ada's Step 5 turn completed and *then* left her over the cap: the check compares the window's recorded usage before a generation starts, never mid-stream.
:::

---

## Step 9 — Raise the cap

`limit` and `mode` are the only mutable fields on a [quota](/docs/modules/quotas#data-model); scope, metric, and window are immutable, because changing them would silently redefine what the historical breaches meant. Raise the limit and Ada resumes immediately — the check reads the meter live, so there is no counter to reset.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-quota --quota-id "$QUOTA_ID" --limit 100000 | jq '{limit, mode}'
soat generate-session-response --session-id "$ADA_SESSION_ID" | jq '{status}'
```

Expected output:

```json
{ "limit": 100000, "mode": "enforce" }
{ "status": "completed" }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.quotas.updateQuota({
  path: { quota_id: quota.id },
  body: { limit: 100000 },
});

const { data: resumed } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: adaSession.id },
  body: {},
});
console.log(resumed.status); // completed
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/quotas/$QUOTA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"limit":100000}' | jq '{limit, mode}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq '{status}'
```

</TabItem>
</Tabs>

To give one named user a different allowance instead of the shared per-actor budget, set `scope_ref` to their actor id — that quota caps only that actor. Note it does not *override* the null-ref quota: every applicable quota is checked, and the tightest one that breaches wins.

---

## Step 10 — A cost cap with no prices protects nothing

This is the one place a quota fails **open**, and the platform refuses to stay quiet about it. A `cost_usd` quota sums the priced cost of the window's events — but an event with no [price-book](/docs/modules/usage#pricing) row carries `cost_usd: null` and contributes `0`. On a project with no prices (like this one), a `cost_usd` cap therefore never breaches and never blocks.

So when a cost check finds metered usage but nothing priced, it files a `quota_unpriced` [exception](/docs/modules/exceptions#severity), deduped on the quota — one dead cap is one triage item, and its `occurrence_count` is the number of generations that ran unprotected.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
COST_QUOTA_ID=$(soat create-quota --project-id "$PROJECT_ID" \
  --scope project --metric cost_usd --window calendar_month --limit 5 | jq -r '.id')

soat add-session-message --session-id "$BLAKE_SESSION_ID" --message "Another use?"
soat generate-session-response --session-id "$BLAKE_SESSION_ID" | jq '{status}'

soat list-exceptions --project-id "$PROJECT_ID" --kind quota_unpriced \
  | jq '.data[0] | {kind, severity, status, title, occurrence_count, detail}'
```

Expected output — the generation is **not** blocked (the cap fails open), and the dead cap is filed for triage:

```json
{ "status": "completed" }
{
  "kind": "quota_unpriced",
  "severity": "warning",
  "status": "open",
  "title": "Cost quota quota_... cannot be enforced: no priced usage in the window",
  "occurrence_count": 1,
  "detail": {
    "quota_id": "quota_...",
    "scope": "project",
    "scope_ref": null,
    "metric": "cost_usd",
    "window": "calendar_month",
    "limit": 5,
    "unpriced_event_count": 2
  }
}
```

Fix it by configuring the [price book](/docs/modules/usage#pricing) — walked through in [Meter and Budget Your Project's Spend](/docs/tutorials/metering-and-budgets). A `tokens` quota has no such dependency: it sums component quantities, which are always recorded. When in doubt, cap tokens.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: costQuota } = await adminSoat.quotas.createQuota({
  body: {
    project_id: PROJECT_ID,
    scope: 'project',
    metric: 'cost_usd',
    window: 'calendar_month',
    limit: 5,
  },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: blakeSession.id },
  body: { message: 'Another use?' },
});
await adminSoat.sessions.generateSessionResponse({
  path: { session_id: blakeSession.id },
  body: {},
});

const { data: filed } = await adminSoat.exceptions.listExceptions({
  params: { query: { project_id: PROJECT_ID, kind: 'quota_unpriced' } },
});
console.log(filed.data[0].detail.unpriced_event_count);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
COST_QUOTA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/quotas" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"scope\":\"project\",\"metric\":\"cost_usd\",\"window\":\"calendar_month\",\"limit\":5}" \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$BLAKE_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Another use?"}' > /dev/null

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$BLAKE_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq '{status}'

curl -s "$SOAT_BASE_URL/api/v1/exceptions?project_id=$PROJECT_ID&kind=quota_unpriced" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0] | {kind, severity, title, detail}'
```

</TabItem>
</Tabs>

---

## Step 11 — Observe before you enforce

Dropping a hard cap onto live traffic is how you find out your estimate was wrong at the worst moment. `mode: monitor` runs the identical check and records the breach — firing the `quota.exceeded` [webhook](/docs/modules/webhooks) and writing a `quotas:MonitorBreach` [audit entry](/docs/modules/audit-log#system-originated-entries) — but lets the request through.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-quota --quota-id "$QUOTA_ID" --limit 1 --mode monitor | jq '{limit, mode}'

soat add-session-message --session-id "$ADA_SESSION_ID" --message "One more use?"
soat generate-session-response --session-id "$ADA_SESSION_ID" | jq '{status}'
```

Expected output — a 1-token cap that a real turn blows straight past, and the turn still completes:

```json
{ "limit": 1, "mode": "monitor" }
{ "status": "completed" }
```

The breach is recorded once per window, with no principal — nobody *requested* it, so the platform records the fact rather than inventing an author:

```bash
soat list-audit-entries --project-id "$PROJECT_ID" --action "quotas:MonitorBreach" \
  | jq '.data[0] | {action, resource_srn, principal_type, principal_id, detail}'
```

```json
{
  "action": "quotas:MonitorBreach",
  "resource_srn": "soat:proj_...:quota:quota_...",
  "principal_type": null,
  "principal_id": null,
  "detail": {
    "kind": "quota_monitor_breach",
    "quota_id": "quota_...",
    "scope": "actor",
    "scope_ref": null,
    "metric": "tokens",
    "window": "calendar_month",
    "window_key": "2026-07",
    "limit": 1,
    "observed_value": 129
  }
}
```

`observed_value` against `limit` is exactly the number you need to pick a real limit before flipping `mode` back to `enforce`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.quotas.updateQuota({
  path: { quota_id: quota.id },
  body: { limit: 1, mode: 'monitor' },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: adaSession.id },
  body: { message: 'One more use?' },
});
const { data: allowed } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: adaSession.id },
  body: {},
});
console.log(allowed.status); // completed — monitor mode does not block

const { data: audit } = await adminSoat.auditLog.listAuditEntries({
  params: {
    query: { project_id: PROJECT_ID, action: 'quotas:MonitorBreach' },
  },
});
console.log(audit.data[0].detail.observed_value, audit.data[0].detail.limit);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/quotas/$QUOTA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"limit":1,"mode":"monitor"}' | jq '{limit, mode}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"One more use?"}' > /dev/null

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$ADA_SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' | jq '{status}'

curl -s "$SOAT_BASE_URL/api/v1/audit-log?project_id=$PROJECT_ID&action=quotas:MonitorBreach" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0] | {action, principal_type, detail}'
```

</TabItem>
</Tabs>

---

## How It Works

- **Three modules, three questions.** [Usage](/docs/modules/usage) answers _"what did this cost?"_. A [Quota](/docs/modules/quotas) answers _"has this scope exceeded its aggregate cap?"_. A [Guardrail](/docs/modules/guardrails) answers _"may this one tool call execute?"_. A quota is cost control, not authorization — an over-budget caller gets `429`, never `403`.
- **The actor comes from the session, never the request.** A caller cannot bill someone else's budget by passing an actor id or writing to `tool_context`; the session owns the actor link, so the actor a quota is enforced against is always the actor the resulting usage event is billed to.
- **Quotas read the meter, not a counter.** `tokens` and `cost_usd` aggregate usage events at check time, which is why a quota and the usage report can never disagree, why raising a limit takes effect instantly, and why `current_usage` is `null` for them.
- **Per-actor is the only reading of a null `scope_ref` that isn't already spellable.** A project-wide aggregate is exactly what a `project` quota expresses, so treating a null-ref actor quota as "all actors pooled" would make it a duplicate under a misleading name.
- **Fail-open is announced.** The one case where a quota does not protect you — a cost cap over unpriced usage — files an exception instead of looking healthy through the API.

## Next Steps

- Price your usage so `cost_usd` caps actually bite, and get pushed a webhook before a budget is hit, in [Meter and Budget Your Project's Spend](/docs/tutorials/metering-and-budgets).
- Give each end user their own long-term memory with `auto_create_memory` on the actor — see [Give Your Agent Long-Term Memory](/docs/tutorials/memories-agent).
- Cap an individual tool call rather than aggregate spend with [Gate a Dangerous Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
- Triage what a breached cap filed — see [Exceptions](/docs/modules/exceptions).
