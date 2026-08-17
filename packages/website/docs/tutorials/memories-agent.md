---
description: 'Give a SOAT agent long-term memory that persists across sessions.'
keywords:
  - AI agent memory
  - long-term memory
  - persistent memory
  - memory extraction
  - conversational memory
sidebar_position: 5
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent with Persistent Memory

This tutorial gives an agent long-term memory that persists across sessions: you
create a [Memory](/docs/modules/memories#key-concepts), write entries and observe
the deduplication outcomes, combine memory with a
[Document](/docs/modules/documents#examples) via `knowledge_config`, let the agent
write facts back with `write_memory_id`, enable automatic extraction, and query the
knowledge layer directly.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and the IAM model before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
- Server is at `http://localhost:5047`.
- [Ollama](https://ollama.com) running locally with a chat model available.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

All code snippets below use a `SoatClient` instance created in Step 1. Memory and knowledge operations use the static SDK classes `Memories` and `MemoryEntries` imported from `@soat/sdk`.

```ts
import {
  SoatClient,
  createClient,
  createConfig,
  Memories,
  MemoryEntries,
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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [Users](/docs/modules/users#examples) for full authentication details.

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

// Memories and MemoryEntries use static SDK classes with an explicit client
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

Every resource in SOAT lives inside a [project](/docs/modules/projects#examples). Create one to hold the memory and agent.

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

Set up a local [AI provider](/docs/modules/ai-providers#examples) backed by Ollama. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

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

## Step 4 — Create a memory

A [Memory](/docs/modules/memories#key-concepts) is a named container that holds a collection of text entries. You can attach `tags` to a memory for later filtering — useful when an agent should search only a subset of all memories in a project.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MEMORY_ID=$(soat create-memory \
  --project-id "$PROJECT_ID" \
  --name "Alice Profile" \
  --description "Facts about customer Alice gathered during support interactions" \
  --tags '["alice","customer"]' | jq -r '.id')
echo "MEMORY_ID: $MEMORY_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: memory } = await Memories.createMemory({
  client: authClient,
  body: {
    project_id: PROJECT_ID,
    name: 'Alice Profile',
    description:
      'Facts about customer Alice gathered during support interactions',
    tags: ['alice', 'customer'],
  },
});
const MEMORY_ID = memory.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MEMORY_ID=$(curl -s -X POST "$SOAT_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Alice Profile\",\"description\":\"Facts about customer Alice gathered during support interactions\",\"tags\":[\"alice\",\"customer\"]}" \
  | jq -r '.id')
echo "MEMORY_ID: $MEMORY_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Write memory entries

Every write goes through the semantic deduplication described in
[Memories — Write Algorithm](/docs/modules/memories#write-algorithm). A manual write has
no agent context, so it produces one of two outcomes: **`created`** (201, the fact is
stored as its own entry) or **`skipped`** (200, a near-identical entry already exists).

The third outcome — **`updated`**, where an existing entry is rewritten to absorb the
incoming fact — needs a model to consolidate the two, so only the agent write paths reach
it. [Step 10](#step-10--observe-the-agent-writing-to-memory) shows it on the `write_memory`
tool.

### 5a — First entry (action: created)

A genuinely new fact. No similar entry exists, so it is stored.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id "$MEMORY_ID" \
  --content "Alice prefers email over phone calls for all support communication"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e1 } = await MemoryEntries.createMemoryEntry({
  client: authClient,
  body: {
    memory_id: MEMORY_ID,
    content:
      'Alice prefers email over phone calls for all support communication',
  },
});
console.log(e1.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memory-entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_id":"'"$MEMORY_ID"'","content":"Alice prefers email over phone calls for all support communication"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

### 5b — Near-duplicate (action: skipped)

Almost identical to 5a, so the write is ignored.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id "$MEMORY_ID" \
  --content "Alice prefers email over phone calls"
# → { "action": "skipped", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e2 } = await MemoryEntries.createMemoryEntry({
  client: authClient,
  body: {
    memory_id: MEMORY_ID,
    content: 'Alice prefers email over phone calls',
  },
});
console.log(e2.action); // "skipped"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memory-entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_id":"'"$MEMORY_ID"'","content":"Alice prefers email over phone calls"}' | jq .
# → { "action": "skipped", ... }
```

</TabItem>
</Tabs>

### 5c — Related content (action: created)

Overlapping content with new detail. There is no model on this path to fold the two facts
into one, so the richer statement is stored as its own entry rather than being appended to
5a — entries stay atomic.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id "$MEMORY_ID" \
  --content "Alice prefers email, especially for billing inquiries; she checks it twice a day"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e3 } = await MemoryEntries.createMemoryEntry({
  client: authClient,
  body: {
    memory_id: MEMORY_ID,
    content:
      'Alice prefers email, especially for billing inquiries; she checks it twice a day',
  },
});
console.log(e3.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memory-entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_id":"'"$MEMORY_ID"'","content":"Alice prefers email, especially for billing inquiries; she checks it twice a day"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

### 5d — Second distinct fact (action: created)

An unrelated fact is stored as a new entry.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id "$MEMORY_ID" \
  --content "The Alice Corp fiscal year ends in March; she starts renewal discussions in January"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e4 } = await MemoryEntries.createMemoryEntry({
  client: authClient,
  body: {
    memory_id: MEMORY_ID,
    content:
      'The Alice Corp fiscal year ends in March; she starts renewal discussions in January',
  },
});
console.log(e4.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memory-entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"memory_id":"'"$MEMORY_ID"'","content":"The Alice Corp fiscal year ends in March; she starts renewal discussions in January"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

---

## Step 6 — List entries to verify

After the four writes, the memory holds exactly **three entries** — only the near-duplicate from 5b was discarded.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memory-entries --memory-id "$MEMORY_ID" | jq '[.data[] | .content]'
# [
#   "Alice prefers email over phone calls for all support communication",
#   "Alice prefers email, especially for billing inquiries; she checks it twice a day",
#   "The Alice Corp fiscal year ends in March; she starts renewal discussions in January"
# ]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: page } = await MemoryEntries.listMemoryEntries({
  client: authClient,
  query: { memory_id: MEMORY_ID },
});
console.log(page.data.map((e) => e.content));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memory-entries?memory_id=$MEMORY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[] | .content]'
```

</TabItem>
</Tabs>

---

## Step 7 — Upload a support-policy document

Store Alice's support policy as a [Document](/docs/modules/documents#examples). The
`path` `/alice/support-policy.txt` lets us later filter the whole `/alice/` subtree
with a single `document_paths` prefix.

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

The `knowledge_config` field on an [agent](/docs/modules/agents#examples) tells SOAT which memories and documents to search before every generation; the query is derived from the last user message automatically. See [Agents](/docs/modules/agents#examples) for the full field list. Here we combine the memory from Step 4 with the document from Step 7, and set `write_memory_id` so the agent gets a `write_memory` tool.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Agent" \
  --instructions "You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely. When you learn new facts about a customer, use the write_memory tool to persist them." \
  --knowledge-config '{"memory_ids":["'"$MEMORY_ID"'"],"document_paths":["/alice/"],"limit":5,"write_memory_id":"'"$MEMORY_ID"'"}' \
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
      memory_ids: [MEMORY_ID],
      document_paths: ['/alice/'],
      limit: 5,
      write_memory_id: MEMORY_ID,
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Agent\",\"instructions\":\"You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely. When you learn new facts about a customer, use the write_memory tool to persist them.\",\"knowledge_config\":{\"memory_ids\":[\"$MEMORY_ID\"],\"document_paths\":[\"/alice/\"],\"limit\":5,\"write_memory_id\":\"$MEMORY_ID\"}}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 9 — Run a generation

Send a user message that requires both customer facts (from memory) and the support policy (from the document). SOAT searches both sources and injects matching results as a `system` message before calling the model.

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

The model combines facts from memory (email preference) and the document (2-hour P1 response) — neither appeared in the user message.

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

If the model decides to call the `write_memory` tool, the fact is persisted via the same deduplication algorithm as manual writes — with one addition. This path has an agent context, so a fact that overlaps an existing entry is consolidated with it into a single atomic fact by the agent's LLM and comes back as `action: "updated"`, instead of landing as a second entry the way 5c did. Send a message that introduces a new fact:

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

After the generation completes, list the memory entries and look for any with `source_type == "agent"`. Entries written during a generation also carry [provenance](/docs/modules/memories#provenance) — the id of the turn that produced them:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memory-entries --memory-id "$MEMORY_ID" \
  | jq '[.data[] | select(.source_type == "agent")
         | {content, source_type, source_generation_id}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: page } = await MemoryEntries.listMemoryEntries({
  client: authClient,
  query: { memory_id: MEMORY_ID },
});
const agentEntries = page.data.filter((e) => e.source_type === 'agent');
console.log(agentEntries.map((e) => [e.content, e.source_generation_id]));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memory-entries?memory_id=$MEMORY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | select(.source_type == "agent")
         | {content, source_type, source_generation_id}]'
```

</TabItem>
</Tabs>

If the model called `write_memory`, you will see an entry with `"source_type": "agent"` containing the timezone fact, and a `source_generation_id` pointing at the generation that wrote it. If the list comes back empty the model simply chose not to call the tool this turn — Step 11 removes that dependency.

---

## Step 11 — Enable automatic extraction

The `write_memory` tool depends on the model _deciding_ to call it. [Automatic extraction](/docs/modules/memories#automatic-extraction) removes that dependency: after every completed turn the server extracts atomic facts from the transcript and writes them with `source: "extraction"`. Enable it by adding `extraction` to the agent's `knowledge_config`:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-agent \
  --agent-id "$AGENT_ID" \
  --knowledge-config '{"memory_ids":["'"$MEMORY_ID"'"],"document_paths":["/alice/"],"limit":5,"write_memory_id":"'"$MEMORY_ID"'","extraction":true}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.agents.updateAgent({
  path: { agent_id: AGENT_ID },
  body: {
    knowledge_config: {
      memory_ids: [MEMORY_ID],
      document_paths: ['/alice/'],
      limit: 5,
      write_memory_id: MEMORY_ID,
      extraction: true,
    },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PUT "$SOAT_URL/api/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"knowledge_config\":{\"memory_ids\":[\"$MEMORY_ID\"],\"document_paths\":[\"/alice/\"],\"limit\":5,\"write_memory_id\":\"$MEMORY_ID\",\"extraction\":true}}" \
  | jq '.knowledge_config'
```

</TabItem>
</Tabs>

`extraction: true` uses the agent's own provider and model with a built-in prompt; the [object form](/docs/modules/memories#automatic-extraction) customizes provider, model, and prompt — useful for running extraction on a cheaper model.

Now send a message that reveals a new fact, without asking the agent to remember anything:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"By the way, Alice signed a 2-year contract renewal last week."}]' \
  | jq '{status: .status}'
```

Extraction runs asynchronously after the generation response returns — give it a few seconds, then list the extracted entries:

```bash
sleep 5
soat list-memory-entries --memory-id "$MEMORY_ID" \
  | jq '[.data[] | select(.source_type == "extraction")
         | {content, source_type, source_generation_id}]'
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

// Extraction runs asynchronously after the generation response returns.
await new Promise((resolve) => setTimeout(resolve, 5000));

const { data: page } = await MemoryEntries.listMemoryEntries({
  client: authClient,
  query: { memory_id: MEMORY_ID },
});
const extracted = page.data.filter((e) => e.source_type === 'extraction');
console.log(extracted.map((e) => e.content));
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
curl -s "$SOAT_URL/api/v1/memory-entries?memory_id=$MEMORY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | select(.source_type == "extraction")
         | {content, source_type, source_generation_id}]'
```

</TabItem>
</Tabs>

You should see an entry like `"Alice signed a 2-year contract renewal"` with `"source_type": "extraction"` — captured without the model choosing to call a tool. The extraction summary is recorded on the generation's `extraction` field ([Generations](/docs/modules/generations)).

---

## Step 12 — Query the knowledge layer directly

The [Knowledge](/docs/modules/knowledge#examples) endpoint is the same search layer the agent uses internally. Pass both `memory_ids` and `document_paths` to see exactly which chunks — from both sources — would be injected for a given question.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "P1 outage response and how to reach Alice" \
  --memory-ids '["'"$MEMORY_ID"'"]' \
  --document-paths '["/alice/"]' \
  | jq '.results[] | {score, similarity_score, source_type, content}'
```

Expected output — note the two different `source_type` values:

```json
{ "score": 0.69, "similarity_score": 0.69, "source_type": "document", "content": "Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours ..." }
{ "score": 0.62, "similarity_score": 0.62, "source_type": "memory", "content": "Alice prefers email, especially for billing inquiries; she checks it twice a day" }
{ "score": 0.50, "similarity_score": 0.50, "source_type": "memory", "content": "The Alice Corp fiscal year ends in March; she starts renewal discussions in January" }
```

Two scores come back, and they are different contracts — see
[Relevance scoring](/docs/modules/knowledge#relevance-scoring):

- **`score`** is the relevance ranking. Results are ordered by it and `min_score` filters on it. It is _implementation-defined_: the ordering is the contract, the number is not. Tune `min_score` against it for this deployment, and re-tune after an upgrade rather than treating a value as portable.
- **`similarity_score`** is the raw cosine similarity, pinned to that meaning. Read it when you need a stable number to compare or log.

They are equal here because the ranking is currently single-signal.

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
    memory_ids: [MEMORY_ID],
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"P1 outage response and how to reach Alice\",\"memory_ids\":[\"$MEMORY_ID\"],\"document_paths\":[\"/alice/\"]}" \
  | jq '.results[] | {score, similarity_score, source_type, content}'
```

</TabItem>
</Tabs>

---

## Step 13 — Trace a fact back to the turn that produced it

Retrieved memory shapes what the agent says, so "why does it believe this?" has to be answerable. Every entry written **during a generation** records [provenance](/docs/modules/memories#provenance): the generation, and the conversation when the turn came from one.

Manual writes have no turn behind them, so the contrast is visible in one listing — the entries from Step 5 carry `null`, while anything the `write_memory` tool or extraction wrote carries an id:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memory-entries --memory-id "$MEMORY_ID" \
  | jq '[.data[] | {source_type, source_generation_id, source_conversation_id}]'
```

```json
[
  {
    "source_type": "manual",
    "source_generation_id": null,
    "source_conversation_id": null
  },
  {
    "source_type": "manual",
    "source_generation_id": null,
    "source_conversation_id": null
  },
  {
    "source_type": "manual",
    "source_generation_id": null,
    "source_conversation_id": null
  },
  {
    "source_type": "extraction",
    "source_generation_id": "gen_0dR2mJk8xQ1vTbLp",
    "source_conversation_id": null
  }
]
```

`source_conversation_id` is `null` above because this tutorial drives the agent with `create-agent-generation`, which has no conversation. Drive the same agent through [Conversations](/docs/modules/conversations) and extraction records both.

Follow a provenance id to the generation itself:

```bash
GEN_ID=$(soat list-memory-entries --memory-id "$MEMORY_ID" \
  | jq -r '[.data[] | select(.source_generation_id != null)][0].source_generation_id // empty')

# → ignore
soat get-generation --generation-id "$GEN_ID" | jq '{id, status, extraction}'
```

The second command is annotated `ignore` because it only has an id to look up if the model actually wrote to memory on this run — the point it demonstrates does not survive being made mandatory. See [Generations](/docs/modules/generations) for the full record, including the `extraction` summary of what that turn contributed.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: page } = await MemoryEntries.listMemoryEntries({
  client: authClient,
  query: { memory_id: MEMORY_ID },
});

page.data.forEach((e) =>
  console.log(e.source_type, e.source_generation_id, e.source_conversation_id)
);

const traced = page.data.find((e) => e.source_generation_id);
if (traced) {
  const { data: generation } = await adminSoat.generations.getGeneration({
    path: { generation_id: traced.source_generation_id },
  });
  console.log(generation.id, generation.status);
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memory-entries?memory_id=$MEMORY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {source_type, source_generation_id, source_conversation_id}]'

GEN_ID=$(curl -s "$SOAT_URL/api/v1/memory-entries?memory_id=$MEMORY_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r '[.data[] | select(.source_generation_id != null)][0].source_generation_id // empty')

curl -s "$SOAT_URL/api/v1/generations/$GEN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, status, extraction}'
```

</TabItem>
</Tabs>

Provenance is recorded when the entry is **created** and is never rewritten by a later merge — it names the turn that first asserted the fact. A fact that is later contradicted is retired rather than edited, which keeps the original entry (and its provenance) readable for audit; pass `--include-invalidated true` to `list-memory-entries` to see retired entries alongside live ones. See [Temporal invalidation](/docs/modules/memories#temporal-invalidation).

---

## What's next

- **Tag-based filtering** — separate memories per customer and `memory_tags` on the agent scope retrieval per customer.
- **Adjust the dedup threshold** — tune `duplicate_threshold` to control how close a fact must be before a manual write is skipped; see [Memories](/docs/modules/memories#write-algorithm).
- **Audit what an agent was told** — pair the provenance ids from Step 13 with the injected `<knowledge>` block documented in [Agents — Knowledge Config](/docs/modules/agents#knowledge-config), whose source tags name the exact entry and document page behind each retrieved line.
