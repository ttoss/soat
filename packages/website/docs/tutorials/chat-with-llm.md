---
sidebar_position: 2
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Chat with an LLM

This tutorial walks through the full flow of having a back-and-forth conversation with an LLM. You will:

1. Log in as admin.
2. Create a project.
3. Store your xAI API key as a secret.
4. Create an AI provider backed by xAI Grok.
5. Create an agent.
6. Open a session.
7. Send messages and receive replies from the model.
8. View the conversation history.
9. Run async generation.
10. Capture generation lifecycle events via webhook.

By the end you will understand how [Secrets](/docs/modules/secrets), [AI Providers](/docs/modules/ai-providers), [Agents](/docs/modules/agents), [Sessions](/docs/modules/sessions), and [Webhooks](/docs/modules/webhooks) compose together to drive both sync and async LLM conversations.

## Prerequisites

- SOAT running locally. Follow [Quick Start](/docs/getting-started) if needed.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Server is at `http://localhost:5047`.
- An xAI API key (`xai-…`).

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

## Step 3 — Store the API key as a secret

SOAT never passes raw API keys to the AI provider directly. Instead, you store the key as an encrypted [Secret](/docs/modules/secrets) and reference it by ID.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SECRET_ID=$(soat create-secret \
  --project-id "$PROJECT_ID" \
  --name "xai-api-key" \
  --value "xai-<your-key-here>" | jq -r '.id')
echo "SECRET_ID: $SECRET_ID"
# SECRET_ID: sec_AfrUVhx5puLWgNkz
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: secret, error } = await adminSoat.secrets.createSecret({
  body: {
    project_id: PROJECT_ID,
    name: 'xai-api-key',
    value: 'xai-<your-key-here>',
  },
});

if (error) throw new Error(JSON.stringify(error));

const SECRET_ID = secret.id; // sec_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SECRET_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xai-api-key\",\"value\":\"xai-<your-key-here>\"}" \
  | jq -r '.id')
echo "SECRET_ID: $SECRET_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create an AI provider

An [AI provider](/docs/modules/ai-providers) pairs a provider slug (`xai`) with a model and credentials. The `secret_id` field tells SOAT which secret holds the API key.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "xAI Grok" \
  --provider "xai" \
  --default-model "grok-3-mini" \
  --secret-id "$SECRET_ID" | jq -r '.id')
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
      name: 'xAI Grok',
      provider: 'xai',
      default_model: 'grok-3-mini',
      secret_id: SECRET_ID,
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"xAI Grok\",\"provider\":\"xai\",\"default_model\":\"grok-3-mini\",\"secret_id\":\"$SECRET_ID\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create an agent

An [agent](/docs/modules/agents) is bound to an AI provider and carries a system prompt (`instructions`). It is the entity that generates responses.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Grok Assistant" \
  --instructions "You are a helpful assistant powered by xAI Grok. Answer clearly and concisely." \
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
    name: 'Grok Assistant',
    instructions:
      'You are a helpful assistant powered by xAI Grok. Answer clearly and concisely.',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Grok Assistant\",\"instructions\":\"You are a helpful assistant powered by xAI Grok. Answer clearly and concisely.\"}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Create a session

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

## Step 7 — Send messages and receive replies

Because `auto_generate` is enabled, every call to `add-session-message` triggers generation immediately and returns the assistant reply inline. The conversation context is maintained across calls — the model sees all previous messages.

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
    "model": "grok-3-mini"
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

### 7b — Follow-up message

The model remembers the previous turn, so you can ask follow-up questions without repeating context.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat add-session-message \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" \
  --message "What is the population of that city?"
```

Example output:

```json
{
  "status": "completed",
  "message": {
    "role": "assistant",
    "content": "The population of Paris, the capital of France, is approximately 2.1 million people in the city proper, based on recent estimates (as of 2022 from sources like INSEE). Note that the greater metropolitan area has a much larger population, exceeding 12 million.",
    "model": "grok-3-mini"
  },
  "generation_id": "agt_gen_1kBL5Nqp5aW9sG5m",
  "trace_id": "agt_trace_DuB3MkGIDg4He8zx"
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reply2, error: err2 } =
  await adminSoat.sessions.addSessionMessage({
    path: { agent_id: AGENT_ID, session_id: SESSION_ID },
    body: { message: 'What is the population of that city?' },
  });

if (err2) throw new Error(JSON.stringify(err2));

console.log(reply2.message?.content);
// "The population of Paris … approximately 2.1 million …"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"What is the population of that city?"}'
```

</TabItem>
</Tabs>

---

## Step 8 — View the conversation history

Fetch all messages in the session to review the full exchange.

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

## Step 9 - Start a local webhook listener

Run the CLI listener in a separate terminal. It starts an HTTP endpoint and prints each matching webhook delivery.

```bash
soat listen --port 8787 --path /webhook --filter sessions.generation.* --json
```

Optional: pass `--secret <webhook-secret>` to validate `X-Soat-Signature`.

---

## Step 10 - Create a session webhook subscription

Subscribe to session generation events so you can observe the async lifecycle.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
WEBHOOK_ID=$(soat create-webhook \
  --project-id "$PROJECT_ID" \
  --name "session-events" \
  --url "http://localhost:8787/webhook" \
  --events '["sessions.generation.*"]' | jq -r '.id')
echo "WEBHOOK_ID: $WEBHOOK_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: webhook, error: webhookErr } =
  await adminSoat.webhooks.createWebhook({
    path: { project_id: PROJECT_ID },
    body: {
      name: 'session-events',
      url: 'http://localhost:8787/webhook',
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
  -d '{"name":"session-events","url":"http://localhost:8787/webhook","events":["sessions.generation.*"]}' \
  | jq -r '.id')
echo "WEBHOOK_ID: $WEBHOOK_ID"
```

</TabItem>
</Tabs>

---

## Step 11 - Trigger async generation

Disable `auto_generate`, add a user message, then trigger generation with `async=true`.

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
  --message "Give me 3 concise facts about Sao Paulo."

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
  body: { message: 'Give me 3 concise facts about Sao Paulo.' },
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
  -d '{"message":"Give me 3 concise facts about Sao Paulo."}'

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

## Step 12 - Verify delivery and final assistant message

Check webhook delivery logs and fetch session messages again.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-webhook-deliveries \
  --project-id "$PROJECT_ID" \
  --webhook-id "$WEBHOOK_ID" | jq '.data[] | {event_type, status, status_code}'

soat list-agent-session-messages \
  --agent-id "$AGENT_ID" \
  --session-id "$SESSION_ID" | jq '.data[] | {role, content}'
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
