---
sidebar_position: 6
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agent with Persistent Memory

This tutorial shows how to give an agent a long-term memory that persists across sessions. You will:

1. Create a [Memory](/docs/modules/memories) container and tag it for filtering.
2. Write memory entries and observe the three deduplication outcomes: **created**, **skipped**, and **updated**.
3. Upload a [Document](/docs/modules/documents) with structured reference information.
4. Create an [agent](/docs/modules/agents) that retrieves from both memories and the document via `knowledge_config`.
5. Run a generation and observe the model answering accurately from injected context — with no RAG logic in the prompt.
6. Query the knowledge layer directly to see memory entries and document chunks side by side.

By the end you will understand how Memories, Documents, and the Knowledge search layer compose with agents to build stateful, context-aware AI assistants.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and the IAM model before diving in.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Advanced Configuration](/docs/getting-started/advanced-config).
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

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [Users](/docs/modules/users) for full authentication details.

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

Every resource in SOAT lives inside a [project](/docs/modules/projects). Create one to hold the memory and agent.

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

Set up a local [AI provider](/docs/modules/ai-providers) backed by Ollama. This tutorial uses a local Ollama provider so it can run without external credentials. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:3b" | jq -r '.id')
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
    default_model: 'qwen2.5:3b',
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Local Ollama\",\"provider\":\"ollama\",\"default_model\":\"qwen2.5:3b\"}" \
  | jq -r '.id')
echo "AI_PROVIDER_ID: $AI_PROVIDER_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create a memory

A [Memory](/docs/modules/memories) is a named container that holds a collection of text entries. You can attach `tags` to a memory for later filtering — useful when an agent should search only a subset of all memories in a project.

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

[Memory entries](/docs/modules/memories#write-algorithm) are the individual facts stored inside a memory. Every write request goes through a semantic deduplication algorithm that compares the new content against existing entries:

- **`created`** (HTTP 201) — no similar entry exists; the new fact is stored.
- **`skipped`** (HTTP 200) — a near-identical entry already exists (similarity ≥ `duplicate_threshold`, default 0.95); the new content is discarded.
- **`updated`** (HTTP 200) — an entry is similar but not identical (similarity ≥ `update_threshold`, default 0.75 and < `duplicate_threshold`); the existing entry is replaced with the richer version.

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
  path: { memory_id: MEMORY_ID },
  body: {
    content:
      'Alice prefers email over phone calls for all support communication',
  },
});
console.log(e1.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories/$MEMORY_ID/entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Alice prefers email over phone calls for all support communication"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

### 5b — Near-duplicate (action: skipped)

The content is almost identical to 5a. The similarity score exceeds `duplicate_threshold` (0.95), so the write is silently ignored and the existing entry is unchanged.

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
  path: { memory_id: MEMORY_ID },
  body: { content: 'Alice prefers email over phone calls' },
});
console.log(e2.action); // "skipped"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories/$MEMORY_ID/entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Alice prefers email over phone calls"}' | jq .
# → { "action": "skipped", ... }
```

</TabItem>
</Tabs>

### 5c — Improved version (action: updated)

The content is related but adds new detail (similarity between 0.75 and 0.95). The existing entry is replaced with the richer version, keeping memory clean and up to date.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id "$MEMORY_ID" \
  --content "Alice prefers email, especially for billing inquiries; she checks it twice a day"
# → { "action": "updated", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e3 } = await MemoryEntries.createMemoryEntry({
  client: authClient,
  path: { memory_id: MEMORY_ID },
  body: {
    content:
      'Alice prefers email, especially for billing inquiries; she checks it twice a day',
  },
});
console.log(e3.action); // "updated"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories/$MEMORY_ID/entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Alice prefers email, especially for billing inquiries; she checks it twice a day"}' | jq .
# → { "action": "updated", ... }
```

</TabItem>
</Tabs>

### 5d — Second distinct fact (action: created)

An unrelated fact is added. No existing entry is similar, so it is stored as a new entry.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id "$MEMORY_ID" \
  --content "Alice's fiscal year ends in March; she starts renewal discussions in January"
# → { "action": "created", ... }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: e4 } = await MemoryEntries.createMemoryEntry({
  client: authClient,
  path: { memory_id: MEMORY_ID },
  body: {
    content:
      "Alice's fiscal year ends in March; she starts renewal discussions in January",
  },
});
console.log(e4.action); // "created"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/memories/$MEMORY_ID/entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Alice'\''s fiscal year ends in March; she starts renewal discussions in January"}' | jq .
# → { "action": "created", ... }
```

</TabItem>
</Tabs>

---

## Step 6 — List entries to verify

After the four writes, the memory holds exactly **two entries** — the skipped near-duplicate was discarded and the improved version replaced the original.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-memory-entries --memory-id "$MEMORY_ID" | jq '[.[] | .content]'
# [
#   "Alice prefers email, especially for billing inquiries; she checks it twice a day",
#   "Alice's fiscal year ends in March; she starts renewal discussions in January"
# ]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: entries } = await MemoryEntries.listMemoryEntries({
  client: authClient,
  path: { memory_id: MEMORY_ID },
});
console.log(entries.map((e) => e.content));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/memories/$MEMORY_ID/entries" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.[] | .content]'
```

</TabItem>
</Tabs>

---

## Step 7 — Upload a support-policy document

A [Document](/docs/modules/documents) is a text file indexed for semantic search. Here we store Alice's account support policy — structured reference material that the agent should consult alongside the memory entries written in Step 5.

The `path` field gives the document a logical location inside the project (similar to a file path). We will use `/alice/support-policy.txt` so we can later filter the entire `/alice/` subtree with a single `document_paths` prefix.

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

The `knowledge_config` field on an [agent](/docs/modules/agents) tells SOAT which memories and documents to search before every generation. The search query is automatically derived from the last user message — no explicit RAG logic needed in the prompt.

The fields you can set in `knowledge_config`:

| Field            | Effect                                                                |
| ---------------- | --------------------------------------------------------------------- |
| `memory_ids`     | Search only these specific memories                                   |
| `memory_tags`    | Search memories whose tags match (supports glob patterns)             |
| `document_paths` | Include chunks from documents whose path starts with the given prefix |
| `document_ids`   | Include chunks from specific documents by ID                          |
| `min_score`      | Minimum cosine similarity (0–1) for a result to be injected           |
| `limit`          | Maximum number of results to inject                                   |

Here we combine the memory from Step 4 with the document uploaded in Step 7 so the agent can draw on both personal customer facts and the structured support policy.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Support Agent" \
  --instructions "You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely." \
  --knowledge-config '{"memory_ids":["'"$MEMORY_ID"'"],"document_paths":["/alice/"],"limit":5}' \
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Support Agent\",\"instructions\":\"You are a helpful customer support assistant. Use the provided knowledge context to answer questions accurately and concisely.\",\"knowledge_config\":{\"memory_ids\":[\"$MEMORY_ID\"],\"document_paths\":[\"/alice/\"],\"limit\":5}}" \
  | jq -r '.id')
echo "AGENT_ID: $AGENT_ID"
```

</TabItem>
</Tabs>

---

## Step 9 — Run a generation

Send a user message that requires combining personal customer facts (from memory) with the support policy (from the document). Before calling the model, SOAT searches both sources using the user message as the query and injects all matching results as a `system` message.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-agent-generation \
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

The model combines two distinct knowledge sources:

- **From memory** — Alice prefers email; she checks it twice a day.
- **From the document** — P1 incidents require a response within 2 hours; outages over 4 hours trigger automatic refunds.

Neither fact appeared in the user message.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: AGENT_ID },
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
curl -s -X POST "$SOAT_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Alice has a P1 outage since 3 hours ago. How should we handle it and how do we best reach her?"}]}' \
  | jq '{status: .status, output: .output.content}'
```

</TabItem>
</Tabs>

---

## Step 10 — Query the knowledge layer directly

The [Knowledge](/docs/modules/knowledge) endpoint is the same search layer the agent uses internally. Pass both `memory_ids` and `document_paths` to see exactly which chunks — from both sources — would be injected for a given question.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "P1 outage response and how to reach Alice" \
  --memory-ids '["'"$MEMORY_ID"'"]' \
  --document-paths '["/alice/"]' \
  | jq '.results[] | {score: .score, source_type: .source_type, content: .content}'
```

Expected output — note the two different `source_type` values:

```json
{ "score": 0.69, "source_type": "document", "content": "Alice Corp Support Policy: All priority-1 incidents must receive an initial response within 2 hours ..." }
{ "score": 0.62, "source_type": "memory", "content": "Alice prefers email, especially for billing inquiries; she checks it twice a day" }
{ "score": 0.50, "source_type": "memory", "content": "Alice's fiscal year ends in March; she starts renewal discussions in January" }
```

Each result shows a `score` (cosine similarity) so you can tune `min_score` and `limit` on `knowledge_config` with confidence.

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
results.forEach((r) => console.log(r.score, r.source_type, r.content));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"P1 outage response and how to reach Alice\",\"memory_ids\":[\"$MEMORY_ID\"],\"document_paths\":[\"/alice/\"]}" \
  | jq '.results[] | {score: .score, source_type: .source_type, content: .content}'
```

</TabItem>
</Tabs>

---

## What's next

- **Tag-based filtering** — create separate memories per customer (e.g. `tags: ["bob"]`) and set `memory_tags: ["alice"]` on the agent to ensure each agent only retrieves the right customer's facts.
- **Agent-sourced entries** — set `source: "agent"` when writing entries programmatically from an agent's output to distinguish automated facts from manually curated ones.
- **Document subtrees** — use `document_paths` prefixes like `/alice/` to scope retrieval to one customer's documents, keeping context focused and token-efficient.
- **Adjust dedup thresholds** — lower `update_threshold` to be more aggressive about replacing stale facts, or raise `duplicate_threshold` to allow more near-duplicate entries to coexist.
