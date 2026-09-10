---
description: "Build a multi-turn LLM chat with managed conversation history on your own infrastructure, via CLI, SDK, or REST."
keywords:
  - chat with an LLM
  - chat completions API
  - conversation history
  - self-hosted LLM chat
  - Ollama
sidebar_position: 2
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chat with an LLM

A multi-turn conversation composed from [AI Providers](/docs/modules/ai-providers#examples), [Agents](/docs/modules/agents#examples), [Sessions](/docs/modules/sessions#examples) and [Webhooks](/docs/modules/webhooks#examples), in sync and background modes.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.
- [Ollama](https://ollama.com) with a chat model; the tutorial test stack provisions `qwen2.5:0.5b`.

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

Admin bypasses policy evaluation. See [Users](/docs/modules/users#examples).

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

const { data: session, error } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

if (error) throw new Error(JSON.stringify(error));

// Rebuild with the admin token
const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: session.token,
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

Every resource lives inside a [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "LLM Chat Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
# PROJECT_ID: proj_vh9qHLINTdsrAqwK
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project, error } = await adminSoat.projects.createProject({
  body: { name: 'LLM Chat Demo' },
});

if (error) throw new Error(JSON.stringify(error));

const PROJECT_ID = project.id; // proj_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"LLM Chat Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create a local AI provider

An Ollama [AI provider](/docs/modules/ai-providers#examples) uses the server's `OLLAMA_BASE_URL`; no secret is required. Other providers: [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
# AI_PROVIDER_ID: aip_8BTcGUvXnehCCQKs
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: aiProvider, error } =
  await adminSoat.aiProviders.createAiProvider({
    body: {
      project_id: PROJECT_ID,
      name: 'Local Ollama',
      provider: 'ollama',
      default_model: 'qwen2.5:0.5b',
    },
  });

if (error) throw new Error(JSON.stringify(error));

const AI_PROVIDER_ID = aiProvider.id; // aip_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create an agent

An [agent](/docs/modules/agents#examples) binds a provider to a system prompt (`instructions`).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Local Assistant" \
  --instructions "You are a concise assistant running on a local Ollama model. Keep answers short (max 20 words), clear, and practical." \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
# AGENT_ID: agent_KO5nAMmsSOVBWLlN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent, error } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Local Assistant',
    instructions:
      'You are a concise assistant running on a local Ollama model. Keep answers short (max 20 words), clear, and practical.',
  },
});

if (error) throw new Error(JSON.stringify(error));

const AGENT_ID = agent.id; // agent_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Local Assistant\",\"instructions\":\"You are a concise assistant running on a local Ollama model. Keep answers short (max 20 words), clear, and practical.\"}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create a session

A [session](/docs/modules/sessions#examples) is one conversation thread on an agent. With `auto_generate: true` every user message gets a reply automatically.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SESSION_RESP=$(soat create-session \
  --agent-id "$AGENT_ID" \
  --name "My first chat" \
  --auto-generate true)
SESSION_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.id')
CONV_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.conversation_id')
echo "SESSION_ID: $SESSION_ID"
# SESSION_ID: sess_N0oEzsx3ayvgKwy3
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session2, error } = await adminSoat.sessions.createSession({
  body: { agent_id: AGENT_ID, name: 'My first chat', auto_generate: true },
});

if (error) throw new Error(JSON.stringify(error));

const SESSION_ID = session2.id; // sess_…
const CONV_ID = session2.conversation_id; // conv_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SESSION_RESP=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"name\":\"My first chat\",\"auto_generate\":true}")
SESSION_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.id')
CONV_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.conversation_id')
echo "SESSION_ID: $SESSION_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Send messages and receive replies

With `auto_generate`, `add-session-message` generates immediately and returns the reply inline; the model sees all previous messages. See [Sessions](/docs/modules/sessions#examples).

### 7a — First message

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat add-session-message \
  --session-id "$SESSION_ID" \
  --message "What is the capital of France?"
```

Example output:

```json
{
  "status": "completed",
  "message": {
    "role": "assistant",
    "content": "The capital of France is Paris.",
    "model": "qwen2.5:0.5b"
  },
  "generation_id": "gen_mznGfHSV4YAGiBXy",
  "trace_id": "trace_8rcvif0n29WE37NL"
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reply1, error: err1 } =
  await adminSoat.sessions.addSessionMessage({
    path: { session_id: SESSION_ID },
    body: { message: 'What is the capital of France?' },
  });

if (err1) throw new Error(JSON.stringify(err1));

console.log(reply1.message?.content);
// "The capital of France is Paris."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"What is the capital of France?"}'
```

</TabItem>
</Tabs>

### 7b — Queue a follow-up message for async generation

Disable `auto_generate` and add a follow-up message; Step 10 generates the reply asynchronously.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-session \
  --session-id "$SESSION_ID" \
  --auto-generate false

soat add-session-message \
  --session-id "$SESSION_ID" \
  --message "In one short sentence, what is the population of Paris?"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reply2, error: err2 } =
  await adminSoat.sessions.addSessionMessage({
    path: { session_id: SESSION_ID },
    body: {
      message: 'In one short sentence, what is the population of Paris?',
    },
  });

if (err2) throw new Error(JSON.stringify(err2));
console.log(reply2.status);
// "pending"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auto_generate":false}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"In one short sentence, what is the population of Paris?"}'
```

</TabItem>
</Tabs>

---

## Step 7 — View the conversation history

Messages are persisted on the underlying [Conversation](/docs/modules/conversations#key-concepts); the session is a scoped view of it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-conversation-messages \
  --conversation-id "$CONV_ID" | jq '.data[] | {role, content}'
```

Example output:

```json
{ "role": "user",      "content": "What is the capital of France?" }
{ "role": "assistant", "content": "The capital of France is Paris." }
{ "role": "user",      "content": "What is the population of that city?" }
{ "role": "assistant", "content": "The population of Paris … approximately 2.1 million …" }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: messages, error } =
  await adminSoat.conversations.listConversationMessages({
    path: { conversation_id: CONV_ID },
  });

if (error) throw new Error(JSON.stringify(error));

for (const msg of messages.data ?? []) {
  console.log(`[${msg.role}] ${msg.content}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[] | {role, content}'
```

</TabItem>
</Tabs>

---

## Step 8 - Start a local webhook listener

Start the listener before creating the webhook; it prints each matching delivery. In automated tests `SOAT_WEBHOOK_BASE_URL` is injected so the server container can reach it. See [CLI Commands](/docs/cli/commands) for `soat listen` flags and [Webhooks](/docs/modules/webhooks#examples) for delivery and signing.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WEBHOOK_BASE_URL=${SOAT_WEBHOOK_BASE_URL:-http://localhost:8787}
soat listen --port 8787 --path /webhook --filter sessions.generation.* --json > session-webhooks.log 2>&1 &
LISTENER_PID=$!
sleep 2
```

Optional: pass `--secret <webhook-secret>` to validate `X-Soat-Signature`.

</TabItem>
<TabItem value="sdk" label="SDK">

Start a local HTTP server for deliveries. In automated tests `SOAT_WEBHOOK_BASE_URL` is injected so the server container can reach it.

</TabItem>
<TabItem value="curl" label="curl">

```bash
WEBHOOK_BASE_URL=${SOAT_WEBHOOK_BASE_URL:-http://localhost:8787}
soat listen --port 8787 --path /webhook --filter sessions.generation.* --json > session-webhooks.log 2>&1 &
LISTENER_PID=$!
sleep 2
```

</TabItem>
</Tabs>

---

## Step 9 - Create a session webhook subscription

Subscribe to session generation events. Event types, retries and HMAC signing: [Webhooks](/docs/modules/webhooks#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WEBHOOK_ID=$(soat create-webhook \
  --project-id "$PROJECT_ID" \
  --name "session-events" \
  --url "$WEBHOOK_BASE_URL/webhook" \
  --events '["sessions.generation.*"]' | jq -r '.id')
echo "WEBHOOK_ID: $WEBHOOK_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const WEBHOOK_BASE_URL =
  process.env.SOAT_WEBHOOK_BASE_URL ?? 'http://localhost:8787';

const { data: webhook, error: webhookErr } =
  await adminSoat.webhooks.createWebhook({
    body: {
      project_id: PROJECT_ID,
      name: 'session-events',
      url: `${WEBHOOK_BASE_URL}/webhook`,
      events: ['sessions.generation.*'],
    },
  });

if (webhookErr) throw new Error(JSON.stringify(webhookErr));

const WEBHOOK_ID = webhook.id; // whk_...
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
WEBHOOK_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"session-events\",\"url\":\"$WEBHOOK_BASE_URL/webhook\",\"events\":[\"sessions.generation.*\"]}" \
  | jq -r '.id')
echo "WEBHOOK_ID: $WEBHOOK_ID"
```

</TabItem>
</Tabs>

---

## Step 10 - Trigger async generation

Background execution is the default: the call returns `202 Accepted` immediately (`wait=true` returns the reply inline). See [Sessions — Background Generation](/docs/modules/sessions#examples) for status codes and polling.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-session \
  --session-id "$SESSION_ID" \
  --auto-generate false

soat add-session-message \
  --session-id "$SESSION_ID" \
  --message "Give me 1 concise fact about Sao Paulo."

soat generate-session-response \
  --session-id "$SESSION_ID"
```

Expected immediate response (accepted):

```json
{
  "status": "accepted",
  "session_id": "sess_..."
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: updateErr } = await adminSoat.sessions.updateSession({
  path: { session_id: SESSION_ID },
  body: { auto_generate: false },
});

if (updateErr) throw new Error(JSON.stringify(updateErr));

const { error: addErr } = await adminSoat.sessions.addSessionMessage({
  path: { session_id: SESSION_ID },
  body: { message: 'Give me 1 concise fact about Sao Paulo.' },
});

if (addErr) throw new Error(JSON.stringify(addErr));

const { data: accepted, error: generateErr } =
  await adminSoat.sessions.generateSessionResponse({
    path: { session_id: SESSION_ID },
  });

if (generateErr) throw new Error(JSON.stringify(generateErr));

console.log(accepted.status); // "accepted"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auto_generate":false}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Give me 1 concise fact about Sao Paulo."}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/sessions/$SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json"
```

</TabItem>
</Tabs>

The `soat listen` terminal logs:

- `sessions.generation.started`
- `sessions.generation.completed`

---

## Step 11 - Verify delivery and final assistant message

Wait for the delivery, then fetch session messages again. Delivery records are queryable via [Webhooks](/docs/modules/webhooks#examples); `status` is `pending`, `success`, or `failed`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → retry 30
soat list-webhook-deliveries --webhook-id "$WEBHOOK_ID" \
  | jq -e '[.data[] | select(.status == "success")] | length > 0'

soat list-webhook-deliveries \
  --webhook-id "$WEBHOOK_ID" | jq '.data[] | {event_type, status, status_code}'

cat session-webhooks.log

soat list-conversation-messages \
  --conversation-id "$CONV_ID" | jq '.data[] | {role, content}'

kill "$LISTENER_PID"
wait "$LISTENER_PID" 2>/dev/null || true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: deliveries, error: deliveriesErr } =
  await adminSoat.webhooks.listWebhookDeliveries({
    query: { webhook_id: WEBHOOK_ID },
  });

if (deliveriesErr) throw new Error(JSON.stringify(deliveriesErr));

for (const d of deliveries.data ?? []) {
  console.log(d.event_type, d.status, d.status_code);
}

const { data: messages2, error: messagesErr } =
  await adminSoat.conversations.listConversationMessages({
    path: { conversation_id: CONV_ID },
  });

if (messagesErr) throw new Error(JSON.stringify(messagesErr));

for (const msg of messages2.data ?? []) {
  console.log(`[${msg.role}] ${msg.content}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/webhook-deliveries?webhook_id=$WEBHOOK_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[] | {event_type, status, status_code}'

curl -s "$SOAT_BASE_URL/api/v1/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[] | {role, content}'
```

</TabItem>
</Tabs>

---

## What's next

- Manual generation: a session without `auto_generate` plus `soat generate-session-response --session-id … --wait true` (omit `--wait true` for background).
- Session tags: `replace-session-tags` / `merge-session-tags` attach filterable metadata.
- Tools: attach builtin or HTTP tools to the agent — [Agents module](/docs/modules/agents#examples).
