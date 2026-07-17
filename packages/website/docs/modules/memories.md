---
description: "Named containers for storing and retrieving knowledge entries within a SOAT project."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Memories

Named containers for storing and retrieving knowledge entries within a project.

## Overview

Memories provide a logical namespace for text content that agents can read and write during generation. Each memory holds many **memory entries** — individual pieces of text that are automatically embedded for semantic search via the [Knowledge](./knowledge.md) module.

Agents can retrieve relevant entries automatically via `knowledge_config` and write new facts using the built-in `write_memory` tool. See [Agent Integration](#agent-integration) for details.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 4 (Create a memory)](/docs/tutorials/memories-agent#step-4--create-a-memory)
- [Agent with Persistent Memory - Step 5 (Write memory entries)](/docs/tutorials/memories-agent#step-5--write-memory-entries)
- [Agent with Persistent Memory - Step 10 (Observe the agent writing to memory)](/docs/tutorials/memories-agent#step-10--observe-the-agent-writing-to-memory)
- [Agent with Persistent Memory - Step 11 (Enable automatic extraction)](/docs/tutorials/memories-agent#step-11--enable-automatic-extraction)

## Data Model

### Memory

| Field         | Type              | Description                               |
| ------------- | ----------------- | ----------------------------------------- |
| `id`          | `string`          | Public ID (`mem_` prefix)                 |
| `project_id`  | `string`          | ID of the owning project                  |
| `name`        | `string`          | Human-readable name                       |
| `description` | `string \| null`  | Optional description                      |
| `tags`        | `string[] \| null`| Optional labels for filtering by category |
| `created_at`  | `string`          | ISO 8601 creation timestamp               |
| `updated_at`  | `string`          | ISO 8601 last-updated timestamp           |

### Memory Entry

Memory entries are the individual knowledge items stored inside a memory. When an entry is created or updated, its `content` is automatically embedded for semantic similarity search.

| Field        | Type     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `id`         | `string` | Public ID (`mem_entry_` prefix)                         |
| `memory_id`  | `string` | ID of the parent memory                                 |
| `content`    | `string` | Text content of the entry                               |
| `source_type` | `string` | How the entry was created: `manual` (default), `agent`, `extraction`, or `orchestration` |
| `tags`       | `string[] \| null` | Per-entry labels for entry-granularity tag filtering in [Knowledge search](./knowledge.md) |
| `metadata`   | `object \| null`   | Arbitrary structured metadata attached to the entry     |
| `created_at` | `string` | ISO 8601 creation timestamp                             |
| `updated_at` | `string` | ISO 8601 last-updated timestamp                         |

## Key Concepts

### Write Algorithm

Every write to a memory — via REST, agent tool, or extraction — goes through the same deduplication algorithm.

When you call `POST /api/v1/memory-entries` (with `memory_id` in the body), the server:

1. **Embeds** the incoming content.
2. **Finds** the most similar existing entry in that memory (cosine similarity via pgvector).
3. **Decides** based on two configurable thresholds:

| Similarity range        | Decision   | What happens                                                               |
| ----------------------- | ---------- | -------------------------------------------------------------------------- |
| ≥ `duplicate_threshold` | **Skip**   | The fact is already known. Returns the existing entry unchanged.           |
| ≥ `update_threshold`    | **Merge**  | The fact overlaps. The two facts are consolidated into the existing entry (see below).      |
| < `update_threshold`    | **Create** | The fact is new. A new entry is created.                                   |

On **Merge**, writes made during a generation (the `write_memory` tool and automatic extraction) consolidate the existing and incoming facts into a **single atomic fact** using the agent's LLM — contradictions resolve in favour of the new fact. Writes without an agent context (the manual `POST /api/v1/memory-entries` endpoint) append the incoming content instead. Consolidation is best-effort: if the completion fails, the write falls back to appending, so a merge never loses content.

See all three outcomes in action in [Agent with Persistent Memory - Step 5 (Write memory entries)](/docs/tutorials/memories-agent#step-5--write-memory-entries).

#### Request Fields

| Field                 | Type     | Default  | Description                                 |
| --------------------- | -------- | -------- | ------------------------------------------- |
| `content`             | string   | —        | The fact or observation to write            |
| `source_type`         | string   | `manual` | How the entry was created: `manual`, `agent`, `extraction`, `orchestration` |
| `tags`                | string[] | —        | Per-entry labels for entry-granularity tag filtering |
| `metadata`            | object   | —        | Arbitrary structured metadata attached to the entry |
| `duplicate_threshold` | number   | `0.95`   | Similarity above which the write is skipped |
| `update_threshold`    | number   | `0.75`   | Similarity above which entries are merged   |

On a **merge**, the incoming `tags` are unioned into the existing entry's tags and `metadata` is shallow-merged (incoming keys win), so accumulated labels are never lost. `PUT /api/v1/memory-entries/:id` replaces `tags`/`metadata` outright; pass `null` (or `[]` for tags) to clear.

#### Response `action` Field

The response always includes an `action` field alongside the entry:

| `action`  | HTTP status | Meaning                                      |
| --------- | ----------- | -------------------------------------------- |
| `created` | `201`       | New entry written                            |
| `updated` | `200`       | Existing entry merged with new content       |
| `skipped` | `200`       | Duplicate detected — existing entry returned |

### Tag Filtering

Tags are free-form strings attached to a memory at creation or update time.

```json
POST /api/v1/memories
{
  "project_id": "proj_abc",
  "name": "Customer Preferences",
  "tags": ["customer", "crm", "user-prefs"]
}
```

Use the `tags` query parameter on `GET /api/v1/memories` to filter. The parameter supports **glob patterns**:

| Pattern      | Matches                                          |
| ------------ | ------------------------------------------------ |
| `crm`        | Only `crm` (exact)                               |
| `customer*`  | `customer`, `customer-support`, `customer-prefs` |
| `user-?refs` | `user-prefs`, `user-xrefs`, etc.                 |

Multiple patterns are **ORed** — a memory is included if any of its tags match any pattern. The same glob syntax applies to `memory_tags` in [Knowledge search](./knowledge.md).

### Entry-Level Tag Filtering

Memory entries carry their own `tags` (and optional `metadata`), independent of the container's tags. `memory_tags` in [Knowledge search](./knowledge.md) and an agent's `knowledge_config.memory_tags` match at **entry granularity**: an entry is returned when either its parent memory's tags match the globs (container-level, all entries returned) **or** the entry's own tags match (only that entry returned). This lets a single memory hold entries for many roles/sources and retrieve just the relevant slice — e.g. tag captured rules with `role:traffic-manager` and `source:rejected_approval`, then search `memory_tags: ["role:traffic-manager"]` to read only those.

```bash
soat create-memory-entry \
  --memory-id mem_01 \
  --content "Reject refunds above $500 for the traffic-manager role" \
  --tags '["role:traffic-manager", "source:rejected_approval"]' \
  --metadata '{"evidence": "high"}'
```

### Orchestration `memory_write` Node

The orchestration `memory_write` node maps its `input_mapping` into a memory-entry write. Besides `content`, the node honors:

- `tags` — either a string array, or a `{ key: value }` mapping that is flattened into `key:value` tag strings (so `tags: { role: "traffic-manager" }` becomes `["role:traffic-manager"]`).
- `metadata` — a plain object stored on the entry.
- `source_type` — honored when supplied; defaults to `orchestration` for node-written entries.

### Agent Integration

Agents can read from and write to memories automatically during generation.

#### Automatic Knowledge Retrieval

Set `knowledge_config` on an agent to have the server search relevant memory entries before every generation and inject them as a delimited reference-context message (never as `system` content, since memory entries can be user-derived). See [Knowledge Config](./agents.md#knowledge-config) in the Agents module.

#### `write_memory` Tool

Set `write_memory_id` in the agent's `knowledge_config` to automatically inject a `write_memory` tool into every generation. The tool accepts a single `content` input — the atomic fact to write. The target memory is fixed by `write_memory_id`; the agent cannot choose a different memory. Entries written by the tool are tagged with `source_type: "agent"`.

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_alice"],
    "write_memory_id": "mem_alice"
  }
}
```

You can set `write_memory_id` to the same memory used for retrieval (so the agent reads from and writes to the same pool) or to a separate memory.

#### Automatic Extraction

Set `extraction` alongside `write_memory_id` to have the server extract facts from completed generation turns automatically — no explicit `write_memory` call by the agent is needed. Pass `true` for the defaults, or an object to customize the provider, model, and prompt used for extraction:

```json
{
  "knowledge_config": {
    "write_memory_id": "mem_alice",
    "extraction": true
  }
}
```

```json
{
  "knowledge_config": {
    "write_memory_id": "mem_alice",
    "extraction": {
      "ai_provider_id": "aip_cheap",
      "model": "gpt-4o-mini",
      "prompt": "Extract only customer food preferences and dietary restrictions."
    }
  }
}
```

How it works:

- After a conversation, session, or direct agent generation completes, the server runs a fire-and-forget extraction step. It never blocks or fails the generation response.
- The extraction step sends the turn's transcript as a plain completion (no tools, no knowledge injection) and asks for a JSON array of atomic facts. Transient content such as greetings is skipped.
- Each candidate fact (at most 20 per turn) goes through the standard [write algorithm](#write-algorithm) — duplicates are skipped, related facts are merged. Entries are tagged with `source_type: "extraction"`.
- A summary (`{ candidates, created, updated, skipped }`) is recorded on the originating generation's `metadata.extraction` field for observability via the [Generations](./generations.md) API.

Object form fields (all optional):

| Field            | Default                  | Description                                                                                              |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `enabled`        | `true`                   | Set `false` to keep the configuration but disable extraction                                              |
| `ai_provider_id` | agent's provider         | Provider override for extraction calls — must belong to the agent's project                               |
| `model`          | see below                | Model override for extraction calls                                                                       |
| `prompt`         | built-in instructions    | Replaces the default task instructions; the JSON response contract and the transcript are always appended |

Model resolution order: `extraction.model` → the override provider's `default_model` (when `ai_provider_id` is set) → the agent's `model` → the agent provider's `default_model`. A provider override switches the fallback to *that* provider's default because the agent's model name is usually meaningless on a different provider.

The custom `prompt` controls *what* to extract, not the response format — the server always appends the JSON-array contract line and the conversation transcript, since the extraction parser accepts nothing else.

Extraction is opt-in and requires both fields: `extraction` without `write_memory_id` does nothing. Streaming generations and `requires_action` (client-tool) turns do not trigger extraction; the turn must complete in the same request.

##### Gating extraction per turn

The agent-level `extraction` flag decides the default, but a single `POST /agents/:id/generate` call can override it with a top-level `extract` boolean (not inside `knowledge_config`):

- `extract` omitted — follow the agent's stored `extraction` default.
- `extract: false` — suppress extraction for this turn even when the agent enables it. Use this for operational or tool-listing turns whose facts would only add noise to a curated memory.
- `extract: true` — force extraction for this turn even when the agent does not enable it by default, provided the agent has a `write_memory_id`. Use this to capture a genuine onboarding turn without leaving extraction on for every turn.

```json
{
  "messages": [{ "role": "user", "content": "List the tools you have." }],
  "extract": false
}
```

The `extract` flag has no effect on streaming or `requires_action` turns (they never extract), and cannot conjure a target: `extract: true` is still a no-op when the agent has no `write_memory_id`.

Extraction reads the agent's stored `knowledge_config` at generation time and normalizes its casing on read, so an agent deployed by a Formation (whose stored config may be snake_case) extracts correctly without needing to be re-saved.

See it end to end in [Agent with Persistent Memory - Step 11 (Enable automatic extraction)](/docs/tutorials/memories-agent#step-11--enable-automatic-extraction).

## Examples

### Create a memory

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --project-id proj_ABC \
  --name "Customer Preferences" \
  --tags '["customer", "crm"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.memories.createMemory({
  body: {
    project_id: 'proj_ABC',
    name: 'Customer Preferences',
    tags: ['customer', 'crm'],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/memories \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Customer Preferences",
    "tags": ["customer", "crm"]
  }'
```

</TabItem>
</Tabs>

### Write a memory entry

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-entry \
  --memory-id mem_01 \
  --content "Customer prefers email over phone calls"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.memories.createMemoryEntry({
  body: { memory_id: 'mem_01', content: 'Customer prefers email over phone calls' },
});
if (error) throw new Error(JSON.stringify(error));
// data.action is "created", "updated", or "skipped"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/memory-entries \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"memory_id": "mem_01", "content": "Customer prefers email over phone calls"}'
```

</TabItem>
</Tabs>
