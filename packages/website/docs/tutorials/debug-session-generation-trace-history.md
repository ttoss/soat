---
description: "A practical workflow for debugging SOAT by mapping sessions, generations, and traces together."
sidebar_position: 6
title: Debug Session, Generation, and Trace History
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Debug Session, Generation, and Trace History

This tutorial teaches a practical debugging workflow for first-time SOAT users. You will build a traceable conversation and keep a deterministic mapping between:

- session_id
- generation_id
- trace_id

By the end, you will be able to:

1. Start from a session and retrieve all messages.
2. Track every generation ID for that session.
3. Inspect each trace and trace tree.
4. Reverse lookup from trace_id to generation_id and session_id using your debug ledger.

This workflow uses [Sessions debugging links](/docs/modules/sessions#debugging-session-generation-trace), [Agent traces](/docs/modules/traces), [Trace debugging joins](/docs/modules/traces#debugging-joins-trace-generation-session), and [Files examples](/docs/modules/files#examples).

## Prerequisites

- A running SOAT instance. Follow [Quick Start](/docs/getting-started) if needed.
- New to the platform? Read [Key Concepts](/docs/getting-started/concepts).
- For production hardening, read [Configuration](/docs/getting-started/advanced-config).
- [Ollama](https://ollama.com) available locally for this example.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 - Login as admin

Use the [Users examples](/docs/modules/users#examples) login flow to get a token.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: login, error: loginError } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});
if (loginError) throw new Error(JSON.stringify(loginError));

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

## Step 2 - Create project, AI provider, agent, and session

Create the minimum resources from [Projects examples](/docs/modules/projects#examples), [AI Providers examples](/docs/modules/ai-providers#examples), [Agents examples](/docs/modules/agents#examples), and [Sessions examples](/docs/modules/sessions#examples).

This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Debug Graph Demo" | jq -r '.id')

AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Debug Assistant" \
  --instructions "You are a concise debugging assistant." | jq -r '.id')

SESSION_RESP=$(soat create-session \
  --agent-id "$AGENT_ID" \
  --name "Debug Session" \
  --auto-generate false)
SESSION_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.id')
CONV_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.conversation_id')

echo "PROJECT_ID=$PROJECT_ID"
echo "AGENT_ID=$AGENT_ID"
echo "SESSION_ID=$SESSION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Debug Graph Demo' },
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
    name: 'Debug Assistant',
    instructions: 'You are a concise debugging assistant.',
  },
});

const { data: session } = await adminSoat.sessions.createSession({
  body: { agent_id: agent.id, name: 'Debug Session', auto_generate: false },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Debug Graph Demo"}' | jq -r '.id')

AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" | jq -r '.id')

AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Debug Assistant\",\"instructions\":\"You are a concise debugging assistant.\"}" | jq -r '.id')

SESSION_RESP=$(curl -s -X POST "$SOAT_URL/api/v1/sessions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"name\":\"Debug Session\",\"auto_generate\":false}")
SESSION_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.id')
CONV_ID=$(printf '%s' "$SESSION_RESP" | jq -r '.conversation_id')
```

</TabItem>
</Tabs>

---

## Step 3 - Run two generations and capture generation_id + trace_id

Use [Sessions debugging links](/docs/modules/sessions#debugging-session-generation-trace) and [Sessions async generation](/docs/modules/sessions#async-generation) endpoints to produce assistant replies and capture the correlation IDs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat add-session-message \
  --session-id "$SESSION_ID" \
  --message "Explain what a generation is in one sentence." > /dev/null

GEN_1=$(soat generate-session-response \
  --session-id "$SESSION_ID")

GEN_1_ID=$(printf '%s\n' "$GEN_1" | jq -r '.generation_id')
TRACE_1_ID=$(printf '%s\n' "$GEN_1" | jq -r '.trace_id')

soat add-session-message \
  --session-id "$SESSION_ID" \
  --message "Now explain what a trace is in one sentence." > /dev/null

GEN_2=$(soat generate-session-response \
  --session-id "$SESSION_ID")

GEN_2_ID=$(printf '%s\n' "$GEN_2" | jq -r '.generation_id')
TRACE_2_ID=$(printf '%s\n' "$GEN_2" | jq -r '.trace_id')

printf '%s\n' "$GEN_1" | jq '{generation_id, trace_id, status}'
printf '%s\n' "$GEN_2" | jq '{generation_id, trace_id, status}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.sessions.addSessionMessage({
  path: { agent_id: agent.id, session_id: session.id },
  body: { message: 'Explain what a generation is in one sentence.' },
});

const { data: gen1 } = await adminSoat.sessions.generateSessionResponse({
  path: { agent_id: agent.id, session_id: session.id },
});

await adminSoat.sessions.addSessionMessage({
  path: { agent_id: agent.id, session_id: session.id },
  body: { message: 'Now explain what a trace is in one sentence.' },
});

const { data: gen2 } = await adminSoat.sessions.generateSessionResponse({
  path: { agent_id: agent.id, session_id: session.id },
});

const debugLinks = [
  {
    sessionId: session.id,
    generationId: gen1.generation_id,
    traceId: gen1.trace_id,
  },
  {
    sessionId: session.id,
    generationId: gen2.generation_id,
    traceId: gen2.trace_id,
  },
];
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Explain what a generation is in one sentence."}' > /dev/null

GEN_1=$(curl -s -X POST "$SOAT_URL/api/v1/sessions/$SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')

curl -s -X POST "$SOAT_URL/api/v1/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Now explain what a trace is in one sentence."}' > /dev/null

GEN_2=$(curl -s -X POST "$SOAT_URL/api/v1/sessions/$SESSION_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')

printf '%s\n' "$GEN_1" | jq '{generation_id, trace_id, status}'
printf '%s\n' "$GEN_2" | jq '{generation_id, trace_id, status}'
```

</TabItem>
</Tabs>

---

## Step 4 - Retrieve the full session message timeline

Use [Sessions key concepts](/docs/modules/sessions#key-concepts) and [Sessions examples](/docs/modules/sessions#examples) to inspect the canonical conversation history.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-conversation-messages \
  --conversation-id "$CONV_ID" | jq '.data[] | {position, role, content}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: messagePage } =
  await adminSoat.conversations.listConversationMessages({
    path: { conversation_id: session.conversation_id },
    query: { limit: 50, offset: 0 },
  });

const timeline = messagePage.data.map((m) => ({
  position: m.position,
  role: m.role,
  content: m.content,
}));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/conversations/$CONV_ID/messages?limit=50&offset=0" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[] | {position, role, content}'
```

</TabItem>
</Tabs>

---

## Step 5 - Inspect traces for each generation

Use [Traces key concepts](/docs/modules/traces#key-concepts), [Trace ancestry model](/docs/modules/traces#trace-ancestry-model), and [Traces examples](/docs/modules/traces#examples) to inspect metadata and tree structure.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-trace --trace-id "$TRACE_1_ID" | jq '{id, agent_id, file_id, parent_trace_id, root_trace_id, step_count}'
soat get-trace-tree --trace-id "$TRACE_1_ID" | jq '{id, children: [.children[].id]}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: trace1 } = await adminSoat.traces.getTrace({
  path: { trace_id: gen1.trace_id },
});

const { data: traceTree1 } = await adminSoat.traces.getTraceTree({
  path: { trace_id: gen1.trace_id },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/traces/$(printf '%s\n' "$GEN_1" | jq -r '.trace_id')" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, agent_id, file_id, parent_trace_id, root_trace_id, step_count}'

curl -s "$SOAT_URL/api/v1/traces/$(printf '%s\n' "$GEN_1" | jq -r '.trace_id')/tree" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, children: [.children[].id]}'
```

</TabItem>
</Tabs>

---

## Step 6 - Download raw trace steps using file_id

Use [Files key concepts](/docs/modules/files#key-concepts) and [Files examples](/docs/modules/files#examples) to inspect raw trace payloads.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TRACE_FILE_ID=$(soat get-trace --trace-id "$TRACE_1_ID" | jq -r '.file_id')
soat download-file-base64 --file-id "$TRACE_FILE_ID" \
  | jq -r '.content' | base64 -d | jq '.[0]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const traceFileId = trace1.file_id;
const { data: traceFile } = await adminSoat.files.downloadFileBase64({
  path: { file_id: traceFileId },
});

const rawTraceSteps = JSON.parse(
  Buffer.from(traceFile.content, 'base64').toString('utf8')
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TRACE_FILE_ID=$(curl -s "$SOAT_URL/api/v1/traces/$TRACE_1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.file_id')

curl -s "$SOAT_URL/api/v1/files/$TRACE_FILE_ID/download/base64" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r '.content' | base64 -d | jq '.[0]'
```

</TabItem>
</Tabs>

---

## Step 7 - Build a reusable debug ledger (reverse lookup)

Use [Trace debugging joins](/docs/modules/traces#debugging-joins-trace-generation-session) to resolve `trace_id -> generation_id[]` directly, then keep a lightweight ledger only for `generation_id -> session_id` correlation.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
curl -s "$SOAT_URL/api/v1/generations?trace_id=$TRACE_1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[].id]'

cat > /tmp/debug-links.json <<EOF
[
  {"session_id":"$SESSION_ID","generation_id":"$GEN_1_ID","trace_id":"$TRACE_1_ID"},
  {"session_id":"$SESSION_ID","generation_id":"$GEN_2_ID","trace_id":"$TRACE_2_ID"}
]
EOF

# Reverse lookup example: trace_id -> generation_id + session_id
jq -r '.[] | select(.trace_id == "'"$TRACE_1_ID"'")' /tmp/debug-links.json
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: traceGenerations } = await adminSoat.generations.listGenerations({
  query: { trace_id: gen1.trace_id },
});

// traceGenerations.data.map((g) => g.id) => ['gen_...', 'gen_...']

const linksByTraceId = new Map(debugLinks.map((row) => [row.traceId, row]));
const reverse = linksByTraceId.get(gen1.trace_id);
// reverse => { sessionId, generationId, traceId }
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/generations?trace_id=$TRACE_1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[].id]'

cat > /tmp/debug-links.json <<EOF
[
  {"session_id":"$SESSION_ID","generation_id":$(printf '%s\n' "$GEN_1" | jq -r '.generation_id | @json'),"trace_id":$(printf '%s\n' "$GEN_1" | jq -r '.trace_id | @json')},
  {"session_id":"$SESSION_ID","generation_id":$(printf '%s\n' "$GEN_2" | jq -r '.generation_id | @json'),"trace_id":$(printf '%s\n' "$GEN_2" | jq -r '.trace_id | @json')}
]
EOF

jq '.' /tmp/debug-links.json
```

</TabItem>
</Tabs>

## What you achieved

You now have a deterministic debugging workflow for:

- session -> all messages
- session -> all generation IDs
- generation -> trace ID
- trace -> generation IDs
- trace -> raw steps and trace tree
- trace -> session via your debug ledger

For direct module references, see [Sessions debugging links](/docs/modules/sessions#debugging-session-generation-trace), [Agent traces](/docs/modules/traces), [Trace debugging joins](/docs/modules/traces#debugging-joins-trace-generation-session), and [Files key concepts](/docs/modules/files#key-concepts).
