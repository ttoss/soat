---
description: 'Give a SOAT agent long-term memory that persists across sessions.'
keywords:
  - AI agent memory
  - long-term memory
  - persistent memory
  - memory rules
  - conversational memory
sidebar_position: 5
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent with Persistent Memory

Give an agent memory that persists across sessions: create a
[memory store](/docs/modules/memories#key-concepts), write memories and observe deduplication,
combine memories with a [Document](/docs/modules/documents#examples) via `knowledge_config`,
let the agent write back with `write_memory_store_id`, give the store a memory rule that
ingests finished turns, and query the knowledge layer directly.

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- [CLI](/docs/cli) or [SDK](/docs/sdk).
- [Ollama](https://ollama.com) with a chat model.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

SDK snippets use the `SoatClient` from Step 1; memory and knowledge operations use the static classes `MemoryStores` and `Memories` from `@soat/sdk`.

```ts
import {
  SoatClient,
  createClient,
  createConfig,
  MemoryStores,
  Memories,
} from '@soat/sdk';
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

See [Users](/docs/modules/users#examples).

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

const ADMIN_TOKEN = login.token;

// Standard resources (projects, agents, AI providers) via SoatClient
const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: ADMIN_TOKEN,
});

// MemoryStores and Memories use static SDK classes with an explicit client
const authClient = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  })
);
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

A [project](/docs/modules/projects#examples) holds the memory store and agent.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Support Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Support Demo' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Support Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create an AI provider

A local Ollama [AI provider](/docs/modules/ai-providers#examples). For xAI, OpenAI, Anthropic, or Amazon Bedrock see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: aiProvider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: PROJECT_ID,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});
const AI_PROVIDER_ID = aiProvider.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AI_PROVIDER_ID=$(curl -s -X POST "$SOAT_URL/api/v1/ai-providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:0.5b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create a memory store

A [memory store](/docs/modules/memories#key-concepts) is a named container of memories; key-value `tags` let an agent search a subset of a project's stores.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MEMORY_STORE_ID=$(soat create-memory-store \
  --project-id "$PROJECT_ID" \
  --name "Alice Profile" \
  --description "Facts about customer Alice gathered during support interactions" \
  --tags '{"customer":"alice","kind":"profile"}' | jq -r '.id')
echo "MEMORY_STORE_ID: $MEMORY_STORE_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: memoryStore } = await MemoryStores.createMemoryStore({
  client: authClient,
  body: {
    project_id: PROJECT_ID,
    name: 'Alice Profile',
    description:
      'Facts about customer Alice gathered during support interactions',
    tags: { customer: 'alice', kind: 'profile' },
  },
});
const MEMORY_STORE_ID = memoryStore.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MEMORY_STORE_ID=$(curl -s -X POST "$SOAT_URL/api/v1/memory-stores" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Alice Profile\",\"description\":\"Facts about customer Alice gathered during support interactions\",\"tags\":{\"customer\":\"alice\",\"kind\":\"profile\"}}" \
  | jq -r '.id')
echo "MEMORY_STORE_ID: $MEMORY_STORE_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Write memories

Every write goes through the same three-outcome algorithm
([Memories — Write Algorithm](/docs/modules/memories#write-algorithm)), on every path:
**`created`** (201, a distinct fact stored as its own memory), **`skipped`** (200, the
fact is already known), or **`superseded`** (200, the same fact has changed — the old
memory is retired and a new one replaces it). Each write also appends one
[assertion](/docs/modules/memories#assertions), whatever it resolved to; Step 5e reads
them back.

### 5a — First memory (action: created)

No similar memory exists, so it is stored.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --memory-store-id "$MEMORY_STORE_ID" \
  --content "Alice prefers email over phone calls for all support communication"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e1 } = await Memories.createMemory({
  client: authClient,
  body: {
    memory_store_id: MEMORY_STORE_ID,
    content:
      'Alice prefers email over phone calls for all support communication',
  },
});
console.log(e1.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_store_id":"'"$MEMORY_STORE_ID"'","content":"Alice prefers email over phone calls for all support communication"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

### 5b — Near-duplicate (action: skipped)

Near-identical to 5a; ignored.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --memory-store-id "$MEMORY_STORE_ID" \
  --content "Alice prefers email over phone calls"
# → { "action": "skipped", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e2 } = await Memories.createMemory({
  client: authClient,
  body: {
    memory_store_id: MEMORY_STORE_ID,
    content: 'Alice prefers email over phone calls',
  },
});
console.log(e2.action); // "skipped"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_store_id":"'"$MEMORY_STORE_ID"'","content":"Alice prefers email over phone calls"}' | jq .
# → { "action": "skipped", ... }
```

</TabItem>
</Tabs>

### 5c — Related content (action: created)

Overlaps 5a with new detail, but not closely enough to count as the same fact, so the
richer statement is stored as its own atomic memory.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --memory-store-id "$MEMORY_STORE_ID" \
  --content "Alice prefers email, especially for billing inquiries; she checks it twice a day"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e3 } = await Memories.createMemory({
  client: authClient,
  body: {
    memory_store_id: MEMORY_STORE_ID,
    content:
      'Alice prefers email, especially for billing inquiries; she checks it twice a day',
  },
});
console.log(e3.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_store_id":"'"$MEMORY_STORE_ID"'","content":"Alice prefers email, especially for billing inquiries; she checks it twice a day"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

### 5d — Second distinct fact (action: created)

Unrelated; stored as a new memory.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --memory-store-id "$MEMORY_STORE_ID" \
  --content "The Alice Corp fiscal year ends in March; she starts renewal discussions in January"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e4 } = await Memories.createMemory({
  client: authClient,
  body: {
    memory_store_id: MEMORY_STORE_ID,
    content:
      'The Alice Corp fiscal year ends in March; she starts renewal discussions in January',
  },
});
console.log(e4.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_store_id":"'"$MEMORY_STORE_ID"'","content":"The Alice Corp fiscal year ends in March; she starts renewal discussions in January"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

### 5e — Read the write ledger

Every write above left an [assertion](/docs/modules/memories#assertions), including 5b,
which produced no memory at all. Newest first:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memory-store-assertions --memory-store-id "$MEMORY_STORE_ID" \
  | jq '[.data[] | {outcome, mechanism, principal_type, content}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: ledger } = await MemoryStores.listMemoryStoreAssertions({
  client: authClient,
  path: { memory_store_id: MEMORY_STORE_ID },
});
console.log(
  ledger.data.map((a) => [a.outcome, a.mechanism, a.principal_type])
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memory-stores/$MEMORY_STORE_ID/assertions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {outcome, mechanism, principal_type, content}]'
```

</TabItem>
</Tabs>

Four rows for four writes: three `created` and the `skipped` from 5b, each `mechanism: "api"`
because they came through the REST door. `content` is the text **as asserted**, so the skipped
row holds what 5b tried to write, not what 5a stored.

---

## Step 6 — List memories to verify

Three memories remain; only 5b was discarded ([Memories examples](/docs/modules/memories#examples)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memories --memory-store-id "$MEMORY_STORE_ID" | jq '[.data[] | .content]'
# [
#   "Alice prefers email over phone calls for all support communication",
#   "Alice prefers email, especially for billing inquiries; she checks it twice a day",
#   "The Alice Corp fiscal year ends in March; she starts renewal discussions in January"
# ]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: page } = await Memories.listMemories({
  client: authClient,
  query: { memory_store_id: MEMORY_STORE_ID },
});
console.log(page.data.map((e) => e.content));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memories?memory_store_id=$MEMORY_STORE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[] | .content]'
```

</TabItem>
</Tabs>

---

## Step 7 — Upload a support-policy document

Store the support policy as a [Document](/docs/modules/documents#examples). The `path`
`/alice/support-policy.txt` lets a single `document_paths` prefix select the `/alice/` subtree.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --path "/alice/support-policy.txt" \
  --content "Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours. Priority-2 incidents within 8 hours. Refunds are approved automatically for outages exceeding 4 hours. Alice Corp is entitled to a dedicated support engineer during business hours (9 AM–6 PM EST)." \
  | jq -r '.id')
echo "DOC_ID: $DOC_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: doc } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    path: '/alice/support-policy.txt',
    content:
      'Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours. Priority-2 incidents within 8 hours. Refunds are approved automatically for outages exceeding 4 hours. Alice Corp is entitled to a dedicated support engineer during business hours (9 AM–6 PM EST).',
  },
});
const DOC_ID = doc.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DOC_ID=$(curl -s -X POST "$SOAT_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/alice/support-policy.txt\",\"content\":\"Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours. Priority-2 incidents within 8 hours. Refunds are approved automatically for outages exceeding 4 hours. Alice Corp is entitled to a dedicated support engineer during business hours (9 AM-6 PM EST).\"}" \
  | jq -r '.id')
echo "DOC_ID: $DOC_ID"
```

</TabItem>
</Tabs>

---

## Step 8 — Create an agent with `knowledge_config`

`knowledge_config` on an [agent](/docs/modules/agents#examples) names the memory stores and documents searched before every generation, with the query derived from the last user message. Here it combines the memory store from Step 4 with the document from Step 7; `write_memory_store_id` gives the agent a `write_memory` tool.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Agent" \
  --instructions "You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely. When you learn new facts about a customer, use the write_memory tool to persist them." \
  --knowledge-config '{"memory_store_ids":["'"$MEMORY_STORE_ID"'"],"document_paths":["/alice/"],"limit":5,"write_memory_store_id":"'"$MEMORY_STORE_ID"'"}' \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: PROJECT_ID,
    ai_provider_id: AI_PROVIDER_ID,
    name: 'Support Agent',
    instructions:
      'You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely.',
    knowledge_config: {
      memory_store_ids: [MEMORY_STORE_ID],
      document_paths: ['/alice/'],
      limit: 5,
      write_memory_store_id: MEMORY_STORE_ID,
    },
  },
});
const AGENT_ID = agent.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Agent\",\"instructions\":\"You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely. When you learn new facts about a customer, use the write_memory tool to persist them.\",\"knowledge_config\":{\"memory_store_ids\":[\"$MEMORY_STORE_ID\"],\"document_paths\":[\"/alice/\"],\"limit\":5,\"write_memory_store_id\":\"$MEMORY_STORE_ID\"}}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 9 — Run a generation

A message needing both customer facts (memory) and the support policy (document). Matches are injected as a fenced reference-context `user` message, never as `system` content, since retrieved knowledge can be user-derived ([Knowledge Config](/docs/modules/agents#knowledge-config)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Alice has a P1 outage since 3 hours ago. How should we handle it and how do we best reach her?"}]' \
  | jq '{status: .status, output: .output.content}'
```

Expected shape:

```json
{
  "status": "completed",
  "output": "Since Alice has a P1 outage, an initial response should have been sent within 2 hours per the support policy ... Contact her by email, which she checks twice a day and prefers for all support communication ..."
}
```

The reply combines memory (email preference) and the document (2-hour P1 response); neither was in the user message.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  query: { wait: true },
  body: {
    messages: [
      {
        role: 'user',
        content:
          'Alice has a P1 outage since 3 hours ago. How should we handle it and how do we best reach her?',
      },
    ],
  },
});

console.log(generation.status); // "completed"
console.log(generation.output.content);
// e.g. "P1 SLA requires a response within 2 hours ... reach Alice by email ..."
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Alice has a P1 outage since 3 hours ago. How should we handle it and how do we best reach her?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

---

## Step 10 — Observe the agent writing to memory

A `write_memory` call goes through exactly the same algorithm as a manual write, on the
store's thresholds — an agent cannot loosen them. What differs is the assertion it records:
`mechanism: "tool"`, the agent as principal, and the generation it happened in. Send a message
with a new fact:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Just so you know, Alice moved to the West Coast and is now in the PT timezone."}]' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: gen2 } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  query: { wait: true },
  body: {
    messages: [
      {
        role: 'user',
        content:
          'Just so you know, Alice moved to the West Coast and is now in the PT timezone.',
      },
    ],
  },
});
console.log(gen2.status); // "completed"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Just so you know, Alice moved to the West Coast and is now in the PT timezone."}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

List the store's memories and look for the timezone fact. A `write_memory` call happens inside a generation that may belong to no conversation, so what it writes carries `source_type: "manual"` — there is no source to name ([Provenance](/docs/modules/memories#provenance)):

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memories --memory-store-id "$MEMORY_STORE_ID" \
  | jq '[.data[] | {content, source_type, source_id}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: page } = await Memories.listMemories({
  client: authClient,
  query: { memory_store_id: MEMORY_STORE_ID },
});
console.log(page.data.map((e) => [e.content, e.source_type, e.source_id]));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memories?memory_store_id=$MEMORY_STORE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {content, source_type, source_id}]'
```

</TabItem>
</Tabs>

If the model called `write_memory`, one memory holds the timezone fact, reading
`"source_type": "manual"` with a null `source_id`. Where it came from is on its assertion
instead — the door, the agent, and the turn:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memory-store-assertions --memory-store-id "$MEMORY_STORE_ID" --mechanism tool \
  | jq '[.data[] | {outcome, principal_id, generation_id, content}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: toolWrites } = await MemoryStores.listMemoryStoreAssertions({
  client: authClient,
  path: { memory_store_id: MEMORY_STORE_ID },
  query: { mechanism: 'tool' },
});
console.log(toolWrites.data.map((a) => [a.principal_id, a.generation_id]));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memory-stores/$MEMORY_STORE_ID/assertions?mechanism=tool" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {outcome, principal_id, generation_id, content}]'
```

</TabItem>
</Tabs>

An empty list means the model did not call the tool; Step 11 removes that dependency.

---

## Step 11 — Add a memory rule

The `write_memory` tool is a *capability grant*: the agent may write, if it decides to. What the
store **accepts** from a finished turn is the store's own policy — a
[memory rule](/docs/modules/memories#memory-rules). Create one on the store, selecting this
agent's turns, with no handler so the built-in extractor runs:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MEMORY_RULE_ID=$(soat create-memory-rule \
  --memory-store-id "$MEMORY_STORE_ID" \
  --on agents.generation.completed \
  --source-agent-ids '["'"$AGENT_ID"'"]' \
  | jq -r '.id')
echo "$MEMORY_RULE_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: rule } = await adminSoat.memoryRules.createMemoryRule({
  body: {
    memory_store_id: MEMORY_STORE_ID,
    on: 'agents.generation.completed',
    source_agent_ids: [AGENT_ID],
  },
});
const MEMORY_RULE_ID = rule.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MEMORY_RULE_ID=$(curl -s -X POST "$SOAT_URL/api/v1/memory-rules" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"memory_store_id\":\"$MEMORY_STORE_ID\",\"on\":\"agents.generation.completed\",\"source_agent_ids\":[\"$AGENT_ID\"]}" \
  | jq -r '.id')
echo "$MEMORY_RULE_ID"
```

</TabItem>
</Tabs>

With no `agent_id` or `tool_id`, the rule runs the built-in extractor on the source agent's
provider and model, with a built-in prompt; `prompt`, `ai_provider_id` and `model` retune it
(e.g. a cheaper model), and an `agent_id` or `tool_id` [handler](/docs/modules/memories#handlers)
replaces the algorithm outright. Leaving `source_agent_ids` out would read **every** agent in
the project.

Send a message revealing a new fact without asking the agent to remember it:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"By the way, Alice signed a 2-year contract renewal last week."}]' \
  | jq '{status: .status}'
```

The rule fires asynchronously after the turn completes; wait a few seconds, then list:

```bash
sleep 5
soat list-memories --memory-store-id "$MEMORY_STORE_ID" \
  | jq '[.data[] | {content, source_type, source_id}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
  query: { wait: true },
  body: {
    messages: [
      {
        role: 'user',
        content:
          'By the way, Alice signed a 2-year contract renewal last week.',
      },
    ],
  },
});

// The rule fires asynchronously after the turn completes.
await new Promise((resolve) => setTimeout(resolve, 5000));

const { data: page } = await Memories.listMemories({
  client: authClient,
  query: { memory_store_id: MEMORY_STORE_ID },
});
console.log(page.data.map((e) => [e.content, e.source_type, e.source_id]));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"By the way, Alice signed a 2-year contract renewal last week."}]}' \
  | jq '{status: .status}'

sleep 5
curl -s "$SOAT_URL/api/v1/memories?memory_store_id=$MEMORY_STORE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {content, source_type, source_id}]'
```

</TabItem>
</Tabs>

Expect a memory like `"Alice signed a 2-year contract renewal"`. This turn is a direct generation with no conversation behind it, so it reads `"source_type": "manual"`; the same turn inside a [conversation](/docs/modules/conversations) would read `"conversation"` and name it in `source_id`. What the rule wrote is recorded on the generation's `extraction` field, keyed by the rule's id ([Generations](/docs/modules/generations)), and each write appends an [assertion](/docs/modules/memories#assertions) naming `rule_id`.

---

## Step 12 — Query the knowledge layer directly

The [Knowledge](/docs/modules/knowledge#examples) endpoint is the search layer the agent uses. Pass `memory_store_ids` and `document_paths` to see which chunks would be injected for a question.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "P1 outage response and how to reach Alice" \
  --memory-store-ids '["'"$MEMORY_STORE_ID"'"]' \
  --document-paths '["/alice/"]' \
  | jq '.results[] | {score, similarity_score, source_type, content}'
```

Expected output (two `source_type` values):

```json
{ "score": 0.69, "similarity_score": 0.69, "source_type": "document", "content": "Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours ..." }
{ "score": 0.62, "similarity_score": 0.62, "source_type": "memory", "content": "Alice prefers email, especially for billing inquiries; she checks it twice a day" }
{ "score": 0.0328, "similarity_score": 0.50, "source_type": "memory", "content": "The Alice Corp fiscal year ends in March; she starts renewal discussions in January" }
```

Two scores, two contracts ([Relevance scoring](/docs/modules/knowledge#relevance-scoring)):

- **`score`**: the reciprocal-rank-fusion value results are ordered by. The ordering is the contract, the number is not — do not persist it or show it as a percentage.
- **`similarity_score`**: raw cosine similarity, stable for comparing or logging, and the field `min_similarity` filters on.

They are different numbers: `score` encodes each result's position in the vector and lexical rankings, not how similar it is.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const res = await fetch('http://localhost:5047/api/v1/knowledge/search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  },
  body: JSON.stringify({
    project_id: PROJECT_ID,
    query: 'P1 outage response and how to reach Alice',
    memory_store_ids: [MEMORY_STORE_ID],
    document_paths: ['/alice/'],
  }),
});

const { results } = await res.json();
results.forEach((r) =>
  console.log(r.score, r.similarity_score, r.source_type, r.content)
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"P1 outage response and how to reach Alice\",\"memory_store_ids\":[\"$MEMORY_STORE_ID\"],\"document_paths\":[\"/alice/\"]}" \
  | jq '.results[] | {score, similarity_score, source_type, content}'
```

</TabItem>
</Tabs>

---

## Step 13 — Trace a fact back to the conversation it came from

A memory records **whether there is a source to point at**
([provenance](/docs/modules/memories#provenance)). Every write so far has been a direct
generation with no conversation behind it, so all of them read `manual` with a null
`source_id`. Write one that names a [conversation](/docs/modules/conversations) and the
pair becomes traceable.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CONVERSATION_ID=$(soat create-conversation \
  --project_id "$PROJECT_ID" --name alice-renewal-call | jq -r '.id')

soat create-memory \
  --memory-store-id "$MEMORY_STORE_ID" \
  --content "Alice's account manager is Priya" \
  --source_type conversation \
  --source_id "$CONVERSATION_ID" \
  | jq '{content, source_type, source_id}'
```

```json
{
  "content": "Alice's account manager is Priya",
  "source_type": "conversation",
  "source_id": "conv_0dR2mJk8xQ1vTbLp"
}
```

Read the whole store to see the two shapes side by side, then follow the id back:

```bash
soat list-memories --memory-store-id "$MEMORY_STORE_ID" \
  | jq '[.data[] | {source_type, source_id}]'

SRC_ID=$(soat list-memories --memory-store-id "$MEMORY_STORE_ID" \
  | jq -r '[.data[] | select(.source_type == "conversation")][0].source_id')

soat get-conversation --conversation-id "$SRC_ID" | jq '{id, name}'
```

A [memory rule](/docs/modules/memories#memory-rules) fills the same pair on its own: a turn
inside a conversation writes `conversation` plus that conversation's id, and a bare generation
writes `manual`, because there is nothing to name.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: conversation } = await adminSoat.conversations.createConversation({
  body: { project_id: PROJECT_ID, name: 'alice-renewal-call' },
});

const { data: sourced } = await Memories.createMemory({
  client: authClient,
  body: {
    memory_store_id: MEMORY_STORE_ID,
    content: "Alice's account manager is Priya",
    source_type: 'conversation',
    source_id: conversation.id,
  },
});
console.log(sourced.source_type, sourced.source_id);

const { data: page } = await Memories.listMemories({
  client: authClient,
  query: { memory_store_id: MEMORY_STORE_ID },
});
page.data.forEach((e) => console.log(e.source_type, e.source_id));

const traced = page.data.find((e) => e.source_type === 'conversation');
if (traced?.source_id) {
  const { data: source } = await adminSoat.conversations.getConversation({
    path: { conversation_id: traced.source_id },
  });
  console.log(source.id, source.name);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CONVERSATION_ID=$(curl -s -X POST "$SOAT_URL/api/v1/conversations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"alice-renewal-call\"}" \
  | jq -r '.id')

curl -s -X POST "$SOAT_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"memory_store_id\":\"$MEMORY_STORE_ID\",\"content\":\"Alice's account manager is Priya\",\"source_type\":\"conversation\",\"source_id\":\"$CONVERSATION_ID\"}" \
  | jq '{content, source_type, source_id}'

curl -s "$SOAT_URL/api/v1/memories?memory_store_id=$MEMORY_STORE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {source_type, source_id}]'

SRC_ID=$(curl -s "$SOAT_URL/api/v1/memories?memory_store_id=$MEMORY_STORE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r '[.data[] | select(.source_type == "conversation")][0].source_id')

curl -s "$SOAT_URL/api/v1/conversations/$SRC_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, name}'
```

</TabItem>
</Tabs>

Provenance is set at creation and never rewritten. `source_id` is a loose pointer: deleting the conversation leaves the id in place, because the fact was still learned there. A fact that has changed is retired, not edited; `--include-invalidated true` on `list-memories` shows retired memories ([Temporal invalidation](/docs/modules/memories#temporal-invalidation)), and `list-memory-assertions` on the replacement names the memory it retired.

---

## What's next

- **Tag-based filtering** — one memory store per customer, `tags` on the agent.
- **Dedup policy** — `duplicate_threshold` and `supersede_threshold` set how close a fact must be to be skipped or to retire the one it restates, per store or per write ([Memories](/docs/modules/memories#where-the-thresholds-come-from)).
- **Audit what an agent was told** — pair provenance ids with the injected `<knowledge>` block ([Agents — Knowledge Config](/docs/modules/agents#knowledge-config)), whose source tags name the memory and document page behind each line.
