---
sidebar_position: 2
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chat with an LLM

This tutorial walks through the full flow of having a back-and-forth conversation with an LLM. You will:

1. Log in as admin.
2. Create a project.
3. Create a local AI provider backed by Ollama.
4. Create an agent.
5. Open a session.
6. Send messages and receive replies from the model.
7. View the conversation history.
8. Run async generation.
9. Capture generation lifecycle events via webhook.

By the end you will understand how [AI Providers](/docs/modules/ai-providers), [Agents](/docs/modules/agents), [Sessions](/docs/modules/sessions), and [Webhooks](/docs/modules/webhooks) compose together to drive both sync and async LLM conversations.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and sessions before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available.
- This repo's tutorial test stack already provisions Ollama with `qwen3.5:0.8b`, so this tutorial runs in automated tests without external credentials.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

CLI path flags in this tutorial are resource-specific and kebab-cased, for example `--agent-id`, `--session-id`, and `--webhook-id`.

</TabItem>
<TabItem value="sdk" label="SDK">

All code snippets below use a `SoatClient` instance. The authenticated instance is created in Step 1 after login.

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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [Users](/docs/modules/users) for full authentication and user management details.

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

Every resource in SOAT lives inside a [project](/docs/modules/projects). Create one to hold the agent and its supporting configuration.

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

For local development and tutorial tests, the simplest setup is an [AI provider](/docs/modules/ai-providers) backed by Ollama. It uses the server's `OLLAMA_BASE_URL`, so no secret is required.

## Step 3 — Create a local AI provider

For local development and tutorial tests, the simplest setup is an [AI provider](/docs/modules/ai-providers) backed by Ollama. It uses the server's `OLLAMA_BASE_URL`, so no secret is required. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen3.5:0.8b" | jq -r '.id')
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
      default_model: 'qwen3.5:0.8b',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen3.5:0.8b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create an agent

An [agent](/docs/modules/agents) is bound to an AI provider and carries a system prompt (`instructions`). It is the entity that generates responses.

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
# AGENT_ID: agt_KO5nAMmsSOVBWLlN
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

const AGENT_ID = agent.id; // agt_…
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

A [session](/docs/modules/sessions) is a single conversation thread tied to an agent. Setting `auto_generate` to `true` means the agent generates a reply automatically every time you send a user message.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SESSION_ID=$(soat create-agent-session \
  --agent-id "$AGENT_ID" \
  --name "My first chat" \
  --auto-generate true | jq -r '.id')
echo "SESSION_ID: $SESSION_ID"
# SESSION_ID: sess_N0oEzsx3ayvgKwy3
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session2, error } = await adminSoat.sessions.createAgentSession({
  path: { agent_id: AGENT_ID },
  body: { name: 'My first chat', auto_generate: true },
});

if (error) throw new Error(JSON.stringify(error));

const SESSION_ID = session2.id; // sess_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SESSION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My first chat","auto_generate":true}' | jq -r '.id')
echo "SESSION_ID: $SESSION_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Send messages and receive replies

Because `auto_generate` is enabled, every call to `add-session-message` triggers generation immediately and returns the assistant reply inline. The conversation context is maintained across calls — the model sees all previous messages. See [Sessions](/docs/modules/sessions) for the full message and generation API.

### 7a — First message

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat add-session-message \
  --agent-id "$AGENT_ID" \
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
    "model": "qwen3.5:0.8b"
  },
  "generation_id": "agt_gen_mznGfHSV4YAGiBXy",
  "trace_id": "agt_trace_8rcvif0n29WE37NL"
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reply1, error: err1 } =
  await adminSoat.sessions.addSessionMessage({
    path: { agent_id: AGENT_ID, session_id: SESSION_ID },
    body: { message: 'What is the capital of France?' },
  });

if (err1) throw new Error(JSON.stringify(err1));

console.log(reply1.message?.content);
// "The capital of France is Paris."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"What is the capital of France?"}'
```

</TabItem>
</Tabs>

### 7b — Queue a follow-up message for async generation

Now disable `auto_generate` and add a follow-up user message. We will generate the assistant reply in Step 10 using async mode.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-session \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" \
  --auto-generate false

soat add-session-message \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" \
  --message "In one short sentence, what is the population of Paris?"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reply2, error: err2 } =
  await adminSoat.sessions.addSessionMessage({
    path: { agent_id: AGENT_ID, session_id: SESSION_ID },
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
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auto_generate":false}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"In one short sentence, what is the population of Paris?"}'
```

</TabItem>
</Tabs>

---

## Step 7 — View the conversation history

Fetch all messages in the session to review the full exchange. Messages are persisted on the underlying [Conversation](/docs/modules/conversations) model; the session provides a scoped view into it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-agent-session-messages \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" | jq '.data[] | {role, content}'
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
  await adminSoat.sessions.listAgentSessionMessages({
    path: { agent_id: AGENT_ID, session_id: SESSION_ID },
  });

if (error) throw new Error(JSON.stringify(error));

for (const msg of messages.data ?? []) {
  console.log(`[${msg.role}] ${msg.content}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[] | {role, content}'
```

</TabItem>
</Tabs>

---

## Step 8 - Start a local webhook listener

Start the CLI listener before creating the webhook. It opens a local HTTP endpoint and prints each matching delivery. In the automated tutorial tests, `SOAT_WEBHOOK_BASE_URL` is injected so the server container can reach this listener. See [CLI Commands](/docs/cli/commands) for all `soat listen` flags and [Webhooks](/docs/modules/webhooks) for the full delivery and signing model.

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

Start a local HTTP server to receive webhook deliveries. In the automated tutorial tests, `SOAT_WEBHOOK_BASE_URL` is injected so the server container can reach this listener.

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

Subscribe to session generation events so you can observe the async lifecycle. See [Webhooks](/docs/modules/webhooks) for the full list of event types, retry rules, and HMAC signing.

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
    path: { project_id: PROJECT_ID },
    body: {
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
WEBHOOK_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects/$PROJECT_ID/webhooks" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"session-events\",\"url\":\"$WEBHOOK_BASE_URL/webhook\",\"events\":[\"sessions.generation.*\"]}" \
  | jq -r '.id')
echo "WEBHOOK_ID: $WEBHOOK_ID"
```

</TabItem>
</Tabs>

---

## Step 10 - Trigger async generation

Disable `auto_generate`, add a user message, then trigger generation with `async=true`. See [Sessions — Async Generation](/docs/modules/sessions) for status codes and how to poll for completion.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-session \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" \
  --auto-generate false

soat add-session-message \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" \
  --message "Give me 1 concise fact about Sao Paulo."

soat generate-session-response \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" \
  --async true
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
  path: { agent_id: AGENT_ID, session_id: SESSION_ID },
  body: { auto_generate: false },
});

if (updateErr) throw new Error(JSON.stringify(updateErr));

const { error: addErr } = await adminSoat.sessions.addSessionMessage({
  path: { agent_id: AGENT_ID, session_id: SESSION_ID },
  body: { message: 'Give me 1 concise fact about Sao Paulo.' },
});

if (addErr) throw new Error(JSON.stringify(addErr));

const { data: accepted, error: generateErr } =
  await adminSoat.sessions.generateSessionResponse({
    path: { agent_id: AGENT_ID, session_id: SESSION_ID },
    query: { async: true },
  });

if (generateErr) throw new Error(JSON.stringify(generateErr));

console.log(accepted.status); // "accepted"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auto_generate":false}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Give me 1 concise fact about Sao Paulo."}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/generate?async=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json"
```

</TabItem>
</Tabs>

When generation runs, your `soat listen` terminal should log events such as:

- `sessions.generation.started`
- `sessions.generation.completed`

---

## Step 11 - Verify delivery and final assistant message

Wait for the async delivery, inspect the webhook listener output, then fetch session messages again. Delivery records are queryable via the [Webhooks](/docs/modules/webhooks) module.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
for _ in $(seq 1 20); do soat list-webhook-deliveries --project-id "$PROJECT_ID" --webhook-id "$WEBHOOK_ID" | jq -e '[.data[] | select(.status == "completed")] | length > 0' && break || sleep 1; done # → ignore

soat list-webhook-deliveries \
  --project-id "$PROJECT_ID" \
  --webhook-id "$WEBHOOK_ID" | jq '.data[] | {event_type, status, status_code}'

cat session-webhooks.log

soat list-agent-session-messages \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" | jq '.data[] | {role, content}'

kill "$LISTENER_PID"
wait "$LISTENER_PID" 2>/dev/null || true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: deliveries, error: deliveriesErr } =
  await adminSoat.webhooks.listWebhookDeliveries({
    path: { project_id: PROJECT_ID, webhook_id: WEBHOOK_ID },
  });

if (deliveriesErr) throw new Error(JSON.stringify(deliveriesErr));

for (const d of deliveries.data ?? []) {
  console.log(d.event_type, d.status, d.status_code);
}

const { data: messages2, error: messagesErr } =
  await adminSoat.sessions.listAgentSessionMessages({
    path: { agent_id: AGENT_ID, session_id: SESSION_ID },
  });

if (messagesErr) throw new Error(JSON.stringify(messagesErr));

for (const msg of messages2.data ?? []) {
  console.log(`[${msg.role}] ${msg.content}`);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/projects/$PROJECT_ID/webhooks/$WEBHOOK_ID/deliveries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[] | {event_type, status, status_code}'

curl -s "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.data[] | {role, content}'
```

</TabItem>
</Tabs>

---

## What's next

- **Manual generation**: Create a session without `auto_generate` and call `generate-session-response` (`soat generate-session-response --agent-id … --session-id …`) explicitly for full control over when the model responds.
- **Session tags**: Use `replace-session-tags` / `merge-session-tags` to attach metadata (e.g. user ID, conversation topic) to a session for filtering.
- **Agents with tools**: Attach SOAT tools or HTTP tools to the agent so the model can take actions. See the [Agents module](/docs/modules/agents).
