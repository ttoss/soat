---
description: "Erase prompt and completion content from agent logs on demand, expire it automatically with a retention window, or never store it at all — while cost, usage and audit records survive intact."
keywords:
  - GDPR AI agents
  - LGPD AI agents
  - zero data retention LLM
  - delete PII from LLM logs
  - AI observability without storing prompts
  - trace retention
  - data deletion
sidebar_position: 22
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Data Retention and Zero-Retention

Two questions block most AI rollouts inside a regulated company: _"what happens to the prompt after the call?"_ and _"can you prove you deleted it?"_. Self-hosting answers the first only halfway — the content is on your infrastructure, but it is still written, and an erasure request still has to be satisfiable per record.

SOAT separates **content** from **skeleton**. Content is what a person said and what the model answered: the [trace](/docs/modules/traces) steps, a generation's `metadata`, `error` and `extraction`. Skeleton is everything a ledger needs: ids, timestamps, `status`, `stop_reason`, token counts, cost, and every usage-attribution field. Every mechanism in this tutorial destroys — or never writes — the first while preserving the second, so an erasure never costs you a billing record.

You will:

1. Run a turn and confirm the content really is stored.
2. **Purge one trace on request** and watch the bytes leave storage while the row survives as a provable skeleton.
3. Purge a single [generation](/docs/modules/generations)'s content, and learn why that is not enough on its own.
4. Prove the usage and cost ledger is untouched by a purge.
5. **Automate it** with a project retention window and a daily sweep.
6. Turn on **zero-retention** for one agent — content is never written in the first place.
7. Make it a project-wide mandate and watch an agent fail to opt back out.

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

Retention and zero-retention are project settings, and changing a project requires the admin role. See [Users](/docs/modules/users#examples) for authentication details.

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

## Step 2 — Create a project, provider, and agent

Retention is scoped to the [project](/docs/modules/projects), so the project is the boundary every policy in this tutorial applies to.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Retention Demo" | jq -r '.id')

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

echo "PROJECT_ID: $PROJECT_ID"
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Retention Demo' },
});

const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: project.id,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: project.id,
    ai_provider_id: provider.id,
    name: 'Support Bot',
    instructions: 'You are a concise assistant. Answer in one short sentence.',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Retention Demo"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Bot\",\"instructions\":\"You are a concise assistant. Answer in one short sentence.\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Run a turn, and confirm the content is stored

Send a message a compliance officer would care about, then read the trace back. `file_id` is the pointer to the stored steps object; `content_redacted_at` is `null` while the content is intact.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SESSION_ID=$(soat create-session --agent-id "$AGENT_ID" \
  --name "Retention session" --auto-generate false | jq -r '.id')

soat add-session-message --session-id "$SESSION_ID" \
  --message "My account number is 4455-9982. What are your support hours?" > /dev/null

TURN=$(soat generate-session-response --wait true --session-id "$SESSION_ID")
GENERATION_ID=$(printf '%s\n' "$TURN" | jq -r '.generation_id')
TRACE_ID=$(printf '%s\n' "$TURN" | jq -r '.trace_id')

soat get-trace --trace-id "$TRACE_ID" \
  | jq '{id, file_id, step_count, content_redacted_at}'
```

The steps object holds the whole exchange — download it and the account number is right there:

```bash
TRACE_FILE_ID=$(soat get-trace --trace-id "$TRACE_ID" | jq -r '.file_id')
soat download-file-base64 --file-id "$TRACE_FILE_ID" \
  | jq -r '.content' | base64 -d | jq 'length'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session } = await adminSoat.sessions.createSession({
  body: { agent_id: agent.id, name: 'Retention session', auto_generate: false },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: session.id },
  body: { message: 'My account number is 4455-9982. What are your support hours?' },
});

const { data: turn } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: session.id },
  query: { wait: true },
  body: {},
});

const { data: trace } = await adminSoat.traces.getTrace({
  path: { trace_id: turn.trace_id },
});
console.log(trace.file_id, trace.content_redacted_at); // 'file_...', null

const { data: traceFile } = await adminSoat.files.downloadFileBase64({
  path: { file_id: trace.file_id },
});
const steps = JSON.parse(
  Buffer.from(traceFile.content, 'base64').toString('utf8')
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"name\":\"Retention session\",\"auto_generate\":false}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"My account number is 4455-9982. What are your support hours?"}' > /dev/null

TURN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{}')

GENERATION_ID=$(printf '%s\n' "$TURN" | jq -r '.generation_id')
TRACE_ID=$(printf '%s\n' "$TURN" | jq -r '.trace_id')

curl -s "$SOAT_BASE_URL/api/v1/traces/$TRACE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id, file_id, step_count, content_redacted_at}'
```

</TabItem>
</Tabs>

Expected output (ids will differ):

```json
{
  "id": "trace_m9u9kHBRpiZ2BTSg",
  "file_id": "file_VsczNprUw29Hd8Nw",
  "step_count": 1,
  "content_redacted_at": null
}
```

---

## Step 4 — Purge the trace on request

This is the erasure primitive: `purge-trace-content` deletes the steps object **from storage** and clears the trace's content columns. It requires the `traces:PurgeTraceContent` action.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat purge-trace-content --trace-id "$TRACE_ID" \
  | jq '{id, file_id, step_count, content_redacted_at, content_redacted_by_principal_type, content_redacted_by_principal_id}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: purgedTrace } = await adminSoat.traces.purgeTraceContent({
  path: { trace_id: turn.trace_id },
});

console.log(purgedTrace.file_id); // null
console.log(purgedTrace.content_redacted_at); // '2026-08-06T...'
console.log(purgedTrace.content_redacted_by_principal_type); // 'user'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X DELETE "$SOAT_BASE_URL/api/v1/traces/$TRACE_ID/content" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id, file_id, step_count, content_redacted_at, content_redacted_by_principal_type, content_redacted_by_principal_id}'
```

</TabItem>
</Tabs>

Expected output:

```json
{
  "id": "trace_m9u9kHBRpiZ2BTSg",
  "file_id": null,
  "step_count": 1,
  "content_redacted_at": "2026-08-06T15:13:49.096Z",
  "content_redacted_by_principal_type": "user",
  "content_redacted_by_principal_id": "user_vAo7SYeHGV6DewYz"
}
```

Three things happened, and each is deliberate:

- **The row survived as a skeleton.** A `404` would prove nothing — it is indistinguishable from a resource that never existed. A purged trace still reads back, carrying `content_redacted_at`, so the erasure is _provable_ to an auditor.
- **The bytes are gone, not orphaned.** The steps object was deleted from storage, and the `File` row with it. Fetching it now fails:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat download-file-base64 --file-id "$TRACE_FILE_ID"
```

Purging again is a no-op — the operation is idempotent and keeps the original timestamp:

```bash
soat purge-trace-content --trace-id "$TRACE_ID" | jq '{content_redacted_at}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await adminSoat.files.downloadFileBase64({
  path: { file_id: trace.file_id },
});
console.log(error); // 404 — the object and its File row are gone

// Idempotent: a second purge keeps the original content_redacted_at.
await adminSoat.traces.purgeTraceContent({ path: { trace_id: turn.trace_id } });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$SOAT_BASE_URL/api/v1/files/$TRACE_FILE_ID/download/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN"   # 404

curl -s -X DELETE "$SOAT_BASE_URL/api/v1/traces/$TRACE_ID/content" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{content_redacted_at}'
```

</TabItem>
</Tabs>

- **It cascaded.** Every descendant trace was purged too, along with all of their generations. A nested agent call writes its own steps object covering the same run, so purging only the named trace would leave that content readable by another path.

---

## Step 5 — Purge a single generation

`purge-generation-content` is the narrower operation: it clears one generation's `metadata`, `error`, `extraction` and the internal recovery state of a paused run, without touching sibling generations. It requires `generations:PurgeGenerationContent`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat purge-generation-content --generation-id "$GENERATION_ID" \
  | jq '{id, status, stop_reason, metadata, content_redacted_at}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: purgedGeneration } =
  await adminSoat.generations.purgeGenerationContent({
    path: { generation_id: turn.generation_id },
  });

console.log(purgedGeneration.metadata); // null
console.log(purgedGeneration.status); // 'completed' — skeleton preserved
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X DELETE "$SOAT_BASE_URL/api/v1/generations/$GENERATION_ID/content" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id, status, stop_reason, metadata, content_redacted_at}'
```

</TabItem>
</Tabs>

:::warning
A generation purge does **not** delete the parent trace's steps object, which holds this generation's content alongside its siblings'. To erase a run completely, purge the **trace** — that is the operation that deletes bytes from storage and cascades to every generation in the tree.
:::

---

## Step 6 — Confirm the ledger survived

This is the property that makes erasure adoptable: you can satisfy a deletion request without losing the record that the spend happened. The [usage](/docs/modules/usage) meter for the purged generation is intact.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-usage-meters --generation-id "$GENERATION_ID" \
  | jq '.data[0] | {generation_id, model, meter_type, components}'

soat get-generation --generation-id "$GENERATION_ID" \
  | jq '{id, status, agent_version, created_at, content_redacted_at, metadata}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: meters } = await adminSoat.usage.listUsageMeters({
  query: { generation_id: turn.generation_id },
});
console.log(meters.data[0].components); // token counts, still there

const { data: skeleton } = await adminSoat.generations.getGeneration({
  path: { generation_id: turn.generation_id },
});
console.log(skeleton.status, skeleton.metadata); // 'completed', null
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/usage/meters?generation_id=$GENERATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[0] | {generation_id, model, meter_type, components}'

curl -s "$SOAT_BASE_URL/api/v1/generations/$GENERATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id, status, agent_version, created_at, content_redacted_at, metadata}'
```

</TabItem>
</Tabs>

Ids, timestamps, `status`, `stop_reason`, token counts, cost, and every attribution field (`action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version`, `routing`) are preserved on purpose. A billing and audit ledger has to outlive a tenant's erasure of the content.

`cost_usd` is `null` above only because this local model has no price rows — see [Metering and Budgets](/docs/tutorials/metering-and-budgets) to price a model and get currency figures. The purge does not touch that number either way.

---

## Step 7 — Automate it with a retention window

A purge on request depends on someone remembering to ask. `trace_content_retention_days` on the project turns it into policy: a daily sweep content-purges every trace in the project older than the window.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id "$PROJECT_ID" \
  --trace-content-retention-days 30 \
  | jq '{id, trace_content_retention_days}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: withRetention } = await adminSoat.projects.updateProject({
  path: { project_id: project.id },
  body: { trace_content_retention_days: 30 },
});
console.log(withRetention.trace_content_retention_days); // 30
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"trace_content_retention_days":30}' \
  | jq '{id, trace_content_retention_days}'
```

</TabItem>
</Tabs>

What the sweep guarantees:

- **Opt-in.** `null` is the default and disables retention entirely, so enabling the feature destroys nothing a project already stored.
- **One purge implementation.** The sweep calls the same code path Step 4 did — same cascade, same storage-aware byte deletion, same `content_redacted_at` semantics, same audit entries and `traces.content_purged` events. There is no second implementation to drift.
- **A run is purged as a unit.** The sweep selects root traces; when a root crosses the window, its whole subtree goes with it, including children written minutes later.
- **Auditable, not anonymous.** Sweep-driven purges are stamped `content_redacted_by_principal_type: "system"` and `content_redacted_by_principal_id: "retention_sweep"`, so an automated erasure is distinguishable from a requested one.

The sweep's schedule is server configuration, not a project field — see [Traces — Configuration](/docs/modules/traces#configuration) for `CONTENT_RETENTION_SWEEP_INTERVAL_MS` and `CONTENT_RETENTION_SWEEP_DISABLED`.

Clear the window with `null` to go back to keeping content until it is purged on demand:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-project --project-id "$PROJECT_ID" \
  --trace-content-retention-days null \
  | jq '{trace_content_retention_days}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.projects.updateProject({
  path: { project_id: project.id },
  body: { trace_content_retention_days: null },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"trace_content_retention_days":null}' | jq '{trace_content_retention_days}'
```

</TabItem>
</Tabs>

---

## Step 8 — Zero-retention for one agent

Retention deletes content after the fact. **Zero-retention never writes it.** For a regulated tenant, "we never stored it" is a stronger claim than "we deleted it": content that was never written cannot leak, cannot be missed by a sweep, and cannot sit in a backup.

Create a second agent for the regulated flow and opt it in with `trace_content_mode: none`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
INTAKE_AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Regulated Intake" \
  --instructions "You are a concise intake assistant. Answer in one short sentence." | jq -r '.id')

soat patch-agent --agent-id "$INTAKE_AGENT_ID" --trace-content-mode none \
  | jq '{id, trace_content_mode}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: intakeAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: project.id,
    ai_provider_id: provider.id,
    name: 'Regulated Intake',
    instructions:
      'You are a concise intake assistant. Answer in one short sentence.',
  },
});

await adminSoat.agents.patchAgent({
  path: { agent_id: intakeAgent.id },
  body: { trace_content_mode: 'none' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
INTAKE_AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Regulated Intake\",\"instructions\":\"You are a concise intake assistant. Answer in one short sentence.\"}" | jq -r '.id')

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/agents/$INTAKE_AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"trace_content_mode":"none"}' | jq '{id, trace_content_mode}'
```

</TabItem>
</Tabs>

Now run a turn through it. The reply still reaches the caller — only the durable record is a skeleton.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
INTAKE_SESSION_ID=$(soat create-session --agent-id "$INTAKE_AGENT_ID" \
  --name "Intake session" --auto-generate false | jq -r '.id')

soat add-session-message --session-id "$INTAKE_SESSION_ID" \
  --message "My card ends in 4242. Is my payment late?" > /dev/null

INTAKE_TURN=$(soat generate-session-response --wait true --session-id "$INTAKE_SESSION_ID")
INTAKE_GENERATION_ID=$(printf '%s\n' "$INTAKE_TURN" | jq -r '.generation_id')
INTAKE_TRACE_ID=$(printf '%s\n' "$INTAKE_TURN" | jq -r '.trace_id')

printf '%s\n' "$INTAKE_TURN" | jq '{status}'

soat get-trace --trace-id "$INTAKE_TRACE_ID" \
  | jq '{id, file_id, content_redacted_at, content_redacted_by_principal_type, content_redacted_by_principal_id}'

soat get-generation --generation-id "$INTAKE_GENERATION_ID" \
  | jq '{id, status, metadata, content_redacted_by_principal_id}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: intakeSession } = await adminSoat.sessions.createSession({
  body: {
    agent_id: intakeAgent.id,
    name: 'Intake session',
    auto_generate: false,
  },
});

await adminSoat.sessions.addSessionMessage({
  path: { session_id: intakeSession.id },
  body: { message: 'My card ends in 4242. Is my payment late?' },
});

const { data: intakeTurn } = await adminSoat.sessions.generateSessionResponse({
  path: { session_id: intakeSession.id },
  query: { wait: true },
  body: {},
});

const { data: intakeTrace } = await adminSoat.traces.getTrace({
  path: { trace_id: intakeTurn.trace_id },
});
console.log(intakeTrace.file_id); // null — no steps object was ever written
console.log(intakeTrace.content_redacted_by_principal_id); // 'zero_retention'
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
INTAKE_SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$INTAKE_AGENT_ID\",\"name\":\"Intake session\",\"auto_generate\":false}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$INTAKE_SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"My card ends in 4242. Is my payment late?"}' > /dev/null

INTAKE_TURN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$INTAKE_SESSION_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{}')

INTAKE_TRACE_ID=$(printf '%s\n' "$INTAKE_TURN" | jq -r '.trace_id')

curl -s "$SOAT_BASE_URL/api/v1/traces/$INTAKE_TRACE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{id, file_id, content_redacted_at, content_redacted_by_principal_id}'
```

</TabItem>
</Tabs>

Expected output — the marker is set from the moment the row exists:

```json
{
  "id": "trace_ZfPUnZBnUR3JAg1z",
  "file_id": null,
  "content_redacted_at": "2026-08-06T15:13:55.490Z",
  "content_redacted_by_principal_type": "system",
  "content_redacted_by_principal_id": "zero_retention"
}
```

Reusing the purge marker means every existing reader already handles "content is unavailable here". The principal id is what distinguishes **never stored** (`zero_retention`) from **stored, then erased** (a user, an API key, or `retention_sweep`).

What is still written is the skeleton, unchanged — which means metering is unaffected:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-usage-meters --generation-id "$INTAKE_GENERATION_ID" \
  | jq '.data[0] | {model, meter_type, components}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: intakeMeters } = await adminSoat.usage.listUsageMeters({
  query: { generation_id: intakeTurn.generation_id },
});
console.log(intakeMeters.data[0].components); // metered exactly as usual
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/usage/meters?generation_id=$(printf '%s\n' "$INTAKE_TURN" | jq -r '.generation_id')" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0] | {model, meter_type, components}'
```

</TabItem>
</Tabs>

:::warning[Trade-off: no recovery after a restart]
The state that resumes a generation paused on a [client tool](/docs/tutorials/client-tools) is itself content, so it is not persisted in this mode. A generation still pauses and resumes normally within a running server, but **a generation paused when the server restarts cannot be recovered**. If restart-recovery matters more than never-stored, use a retention window instead.
:::

---

## Step 9 — Make it a project-wide mandate

Setting `trace_content_mode: none` on the project applies zero-retention to every agent in it — including agents created later.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
REGULATED_PROJECT_ID=$(soat create-project --name "Regulated Tenant" | jq -r '.id')

soat update-project --project-id "$REGULATED_PROJECT_ID" \
  --trace-content-mode none | jq '{id, trace_content_mode}'

REGULATED_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$REGULATED_PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

REGULATED_AGENT_ID=$(soat create-agent \
  --project-id "$REGULATED_PROJECT_ID" \
  --ai-provider-id "$REGULATED_PROVIDER_ID" \
  --name "Tenant Agent" \
  --instructions "You are a concise assistant." | jq -r '.id')
```

The project is a **floor**: an agent may tighten to `none`, but it cannot loosen back to `full`.

```bash
# → expect-fail
soat patch-agent --agent-id "$REGULATED_AGENT_ID" --trace-content-mode full
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: regulatedProject } = await adminSoat.projects.createProject({
  body: { name: 'Regulated Tenant' },
});

await adminSoat.projects.updateProject({
  path: { project_id: regulatedProject.id },
  body: { trace_content_mode: 'none' },
});

const { data: regulatedProvider } = await adminSoat.aiProviders.createAiProvider(
  {
    body: {
      project_id: regulatedProject.id,
      name: 'Local Ollama',
      provider: 'ollama',
      default_model: 'qwen2.5:0.5b',
    },
  }
);

const { data: tenantAgent } = await adminSoat.agents.createAgent({
  body: {
    project_id: regulatedProject.id,
    ai_provider_id: regulatedProvider.id,
    name: 'Tenant Agent',
    instructions: 'You are a concise assistant.',
  },
});

// The project is a floor — loosening back to `full` is refused.
const { error } = await adminSoat.agents.patchAgent({
  path: { agent_id: tenantAgent.id },
  body: { trace_content_mode: 'full' },
});
console.log(error); // 400 VALIDATION_FAILED
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
REGULATED_PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Regulated Tenant"}' | jq -r '.id')

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/projects/$REGULATED_PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"trace_content_mode":"none"}' | jq '{id, trace_content_mode}'

# ... create a provider and an agent in that project, then:
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/agents/$REGULATED_AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"trace_content_mode":"full"}' | jq '{error, code}'   # 400 VALIDATION_FAILED
```

</TabItem>
</Tabs>

Without that rule, a project-wide mandate could be escaped simply by creating a new agent under it. An agent's `null` (the default) inherits the project, and resolution **fails closed**: an unrecognised stored mode resolves to `none` rather than to permission to write content.

---

## What you built

| Need | Mechanism | Where it lives |
| --- | --- | --- |
| "Delete this person's conversation" | `purge-trace-content` | On demand, per run, cascades to descendants |
| "Delete this one generation's payload" | `purge-generation-content` | On demand, per generation |
| "Nothing older than N days" | `trace_content_retention_days` | Project, daily sweep |
| "Never store it at all" | `trace_content_mode: none` | Project (floor) or agent (tighten only) |
| "But keep the invoice" | Skeleton preserved by all four | Ids, status, usage, cost, attribution |

Read next: [Traces — Content Purge, Retention Policy, Zero-Retention](/docs/modules/traces#content-purge), [Generations — Content Purge](/docs/modules/generations#content-purge), [Projects](/docs/modules/projects), and [Audit Log](/docs/modules/audit-log) for the entries every purge writes.
