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

Give an agent memory that persists across sessions: create a
[Memory](/docs/modules/memories#key-concepts), write entries and observe deduplication,
combine memory with a [Document](/docs/modules/documents#examples) via `knowledge_config`,
let the agent write back with `write_memory_id`, enable automatic extraction, and query
the knowledge layer directly.

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

SDK snippets use the `SoatClient` from Step 1; memory and knowledge operations use the static classes `Memories` and `MemoryEntries` from `@soat/sdk`.

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

A [project](/docs/modules/projects#examples) holds the memory and agent.

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

## Step 4 — Create a memory

A [Memory](/docs/modules/memories#key-concepts) is a named container of text entries; `tags` let an agent search a subset of a project's memories.

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

Every write goes through semantic deduplication
([Memories — Write Algorithm](/docs/modules/memories#write-algorithm)). A manual write
has no agent context, so it yields **`created`** (201, stored as its own entry) or
**`skipped`** (200, a near-identical entry exists). The third outcome, **`updated`**
(an existing entry rewritten to absorb the fact), needs a model and is reached only by
agent write paths ([Step 10](#step-10--observe-the-agent-writing-to-memory)).

### 5a — First entry (action: created)

No similar entry exists, so it is stored.

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

Near-identical to 5a; ignored.

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

Overlaps 5a with new detail. No model on this path folds the two, so the richer statement
is stored as its own atomic entry.

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

Unrelated; stored as a new entry.

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

Three entries remain; only 5b was discarded ([Memories examples](/docs/modules/memories#examples)).

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

`knowledge_config` on an [agent](/docs/modules/agents#examples) names the memories and documents searched before every generation, with the query derived from the last user message. Here it combines the memory from Step 4 with the document from Step 7; `write_memory_id` gives the agent a `write_memory` tool.

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

A `write_memory` call goes through the same deduplication as manual writes, plus one outcome: with an agent context, a fact overlapping an existing entry is consolidated into one atomic fact by the agent's LLM and returns `action: "updated"` instead of a second entry as in 5c. Send a message with a new fact:

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

List entries with `source_type == "agent"`. Entries written during a generation carry [provenance](/docs/modules/memories#provenance), the id of the turn that produced them:

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

If the model called `write_memory`, an entry with `"source_type": "agent"` holds the timezone fact and `source_generation_id` points at the generation. An empty list means the model did not call the tool; Step 11 removes that dependency.

---

## Step 11 — Enable automatic extraction

[Automatic extraction](/docs/modules/memories#automatic-extraction) extracts atomic facts from the transcript after every completed turn and writes them with `source: "extraction"`. Add `extraction` to the agent's `knowledge_config`:

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

`extraction: true` uses the agent's provider and model with a built-in prompt; the [object form](/docs/modules/memories#automatic-extraction) sets provider, model, and prompt (e.g. a cheaper model).

Send a message revealing a new fact without asking the agent to remember it:

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation --wait true \
  --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"By the way, Alice signed a 2-year contract renewal last week."}]' \
  | jq '{status: .status}'
```

Extraction runs asynchronously after the response returns; wait a few seconds, then list:

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

Expect an entry like `"Alice signed a 2-year contract renewal"` with `"source_type": "extraction"`. The summary is recorded on the generation's `extraction` field ([Generations](/docs/modules/generations)).

---

## Step 12 — Query the knowledge layer directly

The [Knowledge](/docs/modules/knowledge#examples) endpoint is the search layer the agent uses. Pass `memory_ids` and `document_paths` to see which chunks would be injected for a question.

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

Expected output (two `source_type` values):

```json
{ "score": 0.69, "similarity_score": 0.69, "source_type": "document", "content": "Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours ..." }
{ "score": 0.62, "similarity_score": 0.62, "source_type": "memory", "content": "Alice prefers email, especially for billing inquiries; she checks it twice a day" }
{ "score": 0.50, "similarity_score": 0.50, "source_type": "memory", "content": "The Alice Corp fiscal year ends in March; she starts renewal discussions in January" }
```

Two scores, two contracts ([Relevance scoring](/docs/modules/knowledge#relevance-scoring)):

- **`score`**: relevance ranking; results are ordered by it and `min_score` filters on it. Implementation-defined: the ordering is the contract, the number is not. Re-tune `min_score` after an upgrade.
- **`similarity_score`**: raw cosine similarity, stable for comparing or logging.

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

Every entry written during a generation records [provenance](/docs/modules/memories#provenance): the generation, and the conversation when the turn came from one. Manual writes carry `null`; `write_memory` and extraction entries carry an id:

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

`source_conversation_id` is `null` because `create-agent-generation` has no conversation; through [Conversations](/docs/modules/conversations) both are recorded.

Follow a provenance id to the generation:

```bash
GEN_ID=$(soat list-memory-entries --memory-id "$MEMORY_ID" \
  | jq -r '[.data[] | select(.source_generation_id != null)][0].source_generation_id // empty')

# → ignore
soat get-generation --generation-id "$GEN_ID" | jq '{id, status, extraction}'
```

The second command is annotated `ignore` because it has an id only if the model wrote to memory on this run. See [Generations](/docs/modules/generations) for the full record, including the `extraction` summary.

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

Provenance is set at creation and never rewritten by a later merge. A contradicted fact is retired, not edited; `--include-invalidated true` on `list-memory-entries` shows retired entries ([Temporal invalidation](/docs/modules/memories#temporal-invalidation)).

---

## What's next

- **Tag-based filtering** — one memory per customer, `tags` on the agent.
- **Dedup threshold** — `duplicate_threshold` sets how close a fact must be to be skipped ([Memories](/docs/modules/memories#write-algorithm)).
- **Audit what an agent was told** — pair provenance ids with the injected `<knowledge>` block ([Agents — Knowledge Config](/docs/modules/agents#knowledge-config)), whose source tags name the entry and document page behind each line.
