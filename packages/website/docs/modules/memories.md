---
description: "Named containers for storing and retrieving knowledge entries within a SOAT project."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Memories

Named containers for storing and retrieving knowledge entries within a project.

## Overview

Memories provide a logical namespace for text content that agents can read and write during generation. Each memory holds many **memory entries** — individual pieces of text that are automatically embedded for semantic search via the [Knowledge](./knowledge.md) module.

Agents can retrieve relevant entries automatically via `knowledge_config` and write new facts using the built-in `write_memory` tool. See [Agent Integration](#agent-integration) for details, and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive for how the write, extraction, and retrieval algorithms fit together end to end.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 4 (Create a memory)](/docs/tutorials/memories-agent#step-4--create-a-memory)
- [Agent with Persistent Memory - Step 5 (Write memory entries)](/docs/tutorials/memories-agent#step-5--write-memory-entries)
- [Agent with Persistent Memory - Step 10 (Observe the agent writing to memory)](/docs/tutorials/memories-agent#step-10--observe-the-agent-writing-to-memory)
- [Agent with Persistent Memory - Step 11 (Enable automatic extraction)](/docs/tutorials/memories-agent#step-11--enable-automatic-extraction)
- [Agent with Persistent Memory - Step 13 (Trace a fact back to the turn that produced it)](/docs/tutorials/memories-agent#step-13--trace-a-fact-back-to-the-turn-that-produced-it)

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
| `source_generation_id` | `string \| null` | The [generation](./agents.md) whose turn produced the entry — see [Provenance](#provenance) |
| `source_conversation_id` | `string \| null` | The [conversation](./conversations.md) the producing turn belonged to — see [Provenance](#provenance) |
| `invalidated_at` | `string \| null` | When the entry was superseded; `null` means currently valid — see [Temporal invalidation](#temporal-invalidation) |
| `superseded_by_entry_id` | `string \| null` | The entry that replaced this one, when superseded |
| `created_at` | `string` | ISO 8601 creation timestamp                             |
| `updated_at` | `string` | ISO 8601 last-updated timestamp                         |

## Key Concepts

### What belongs in a memory

A memory entry is a **fact the agent learns about the world** — a customer's shipping
address, a decision a team reached, a constraint discovered while working. It is retrieved
by semantic similarity and consumed as context.

A **correction to the agent's behavior** is not a fact, and does not belong here.
"Never quote a delivery date without checking stock" is doctrine about how the agent should
act; storing it as an entry makes its application depend on whether a retrieval happened to
rank it highly. Doctrine has two durable homes instead:

- **A constraint that must never be violated** — a [guardrail](./guardrails.md) `deny`,
  which refuses the action deterministically rather than hoping the model reads the entry.
- **Guidance the model should follow** — the agent's `instructions`, which
  [agent versions](./agents.md#versioning-and-staged-rollout) archive on every write, so the
  change is attributable and reversible.

When the same correction keeps being made by hand, the
[approvals recurrence view](./approvals.md#recurrence-view) is what surfaces it.

### Write Algorithm

Every write to a memory — via REST, agent tool, or extraction — goes through the same deduplication algorithm.

When you call [`POST /api/v1/memory-entries`](/docs/api/memoryEntries/create-memory-entry) (with `memory_id` in the body), the server:

1. **Embeds** the incoming content.
2. **Finds** the most similar **currently-valid** existing entry in that memory (cosine similarity via pgvector). [Invalidated entries](#temporal-invalidation) are never candidates.
3. **Decides** based on two configurable thresholds:

| Similarity range        | Decision   | What happens                                                               |
| ----------------------- | ---------- | -------------------------------------------------------------------------- |
| ≥ `duplicate_threshold` | **Skip**   | The fact is already known. Returns the existing entry unchanged.           |
| ≥ `update_threshold`    | **Merge**  | The fact overlaps. The two facts are consolidated into the existing entry (see below).      |
| < `update_threshold`    | **Create** | The fact is new. A new entry is created.                                   |

On **Merge**, writes made during a generation (the `write_memory` tool and automatic extraction) consolidate the existing and incoming facts into a **single atomic fact** using the agent's LLM — contradictions resolve in favour of the new fact. Writes without an agent context (the manual [`POST /api/v1/memory-entries`](/docs/api/memoryEntries/create-memory-entry) endpoint) append the incoming content instead. Consolidation is best-effort: if the completion fails, the write falls back to appending, so a merge never loses content.

See all three outcomes in action in [Agent with Persistent Memory - Step 5 (Write memory entries)](/docs/tutorials/memories-agent#step-5--write-memory-entries).

The thresholds are per-request fields: `duplicate_threshold` (default `0.95`) and `update_threshold` (default `0.75`).

On a **merge**, the incoming `tags` are unioned into the existing entry's tags and `metadata` is shallow-merged (incoming keys win), so accumulated labels are never lost. [`PUT /api/v1/memory-entries/:id`](/docs/api/memoryEntries/update-memory-entry) replaces `tags`/`metadata` outright; pass `null` (or `[]` for tags) to clear.

#### Response `action` Field

The response always includes an `action` field alongside the entry:

| `action`  | HTTP status | Meaning                                      |
| --------- | ----------- | -------------------------------------------- |
| `created` | `201`       | New entry written                            |
| `updated` | `200`       | Existing entry merged with new content       |
| `skipped` | `200`       | Duplicate detected — existing entry returned |
| `superseded` | `200`    | The incoming fact contradicted an existing entry, which was invalidated and replaced. Produced by the LLM-arbitrated write path, which has not shipped yet — the value is part of the API contract so clients can handle it from day one. |

### Provenance

Entries written during a generation record where the fact came from, so "why does the
agent believe this" is answerable from the entry itself:

| Written by | `source_generation_id` | `source_conversation_id` |
| --- | --- | --- |
| [`write_memory` tool](#write_memory-tool) | the generation that called the tool | `null` — the tool has no conversation context |
| [Automatic extraction](#automatic-extraction) | the generation whose turn was extracted | the conversation, when the turn came from one |
| [`POST /api/v1/memory-entries`](/docs/api/memoryEntries/create-memory-entry) | `null` | `null` |
| [Orchestration `memory_write` node](#orchestration-memory_write-node) | `null` | `null` |

Provenance is recorded **when the entry is created and never rewritten by a later merge**:
it names the turn that first asserted the fact. A later turn that genuinely replaces the
fact supersedes it with a new entry, which carries its own provenance.

Both fields are `null` when the referenced generation or conversation is deleted — removing
a conversation never deletes the facts learned from it.

See it end to end in [Agent with Persistent Memory - Step 13 (Trace a fact back to the turn that produced it)](/docs/tutorials/memories-agent#step-13--trace-a-fact-back-to-the-turn-that-produced-it).

### Temporal invalidation

An entry that no longer holds is **retired rather than rewritten**. Superseding sets
`invalidated_at` and points `superseded_by_entry_id` at the replacement, so the history
stays intact: `DELETE` remains the way to remove an entry outright.

Invalidated entries are excluded from:

- entry listing ([`GET /api/v1/memory-entries`](/docs/api/memoryEntries/list-memory-entries)) unless `include_invalidated=true` is passed
- [write deduplication](#write-algorithm) — a retired fact is never a merge target, so
  restating superseded knowledge creates a new entry
- [Knowledge search](./knowledge.md), so a retired fact is never injected into a generation

They stay readable by ID ([`GET /api/v1/memory-entries/{entry_id}`](/docs/api/memoryEntries/get-memory-entry)) for audit.

The write path that *produces* an invalidation — LLM arbitration over a shortlist of
similar entries — has not shipped yet; the columns and the API shape are in place because
supersede history cannot be reconstructed after the fact.

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

Use the `tags` query parameter on [`GET /api/v1/memories`](/docs/api/memories/list-memories) to filter. The parameter supports **glob patterns**:

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

How it works:

- After a conversation, session, or direct agent generation completes, the server runs a fire-and-forget extraction step. It never blocks or fails the generation response.
- The extraction step sends the turn's transcript as a plain completion (no tools, no knowledge injection) and asks for a JSON array of atomic facts. Transient content such as greetings is skipped.
- Each candidate fact (at most 20 per turn) goes through the standard [write algorithm](#write-algorithm) — duplicates are skipped, related facts are merged. Entries are tagged with `source_type: "extraction"`.
- A summary (`{ candidates, created, updated, skipped }`) is recorded on the originating generation's `extraction` field for observability via the [Generations](./generations.md) API.

Object form fields (all optional):

| Field            | Default                  | Description                                                                                              |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `enabled`        | `true`                   | Set `false` to keep the configuration but disable extraction                                              |
| `ai_provider_id` | agent's provider         | Provider override for extraction calls — must belong to the agent's project                               |
| `model`          | see below                | Model override for extraction calls                                                                       |
| `prompt`         | built-in instructions    | Replaces the default task instructions; the JSON response contract and the transcript are always appended |

Provider resolution order: `extraction.ai_provider_id` → the agent's pinned provider → the agent's [`model_route_id`](./model-routes.md) → the project's [`default_model_route_id`](./model-routes.md#project-default-route). Model resolution for the provider cases: `extraction.model` → the override provider's `default_model` (when `ai_provider_id` is set) → the agent's `model` → the agent provider's `default_model`. A provider override switches the fallback to *that* provider's default because the agent's model name is usually meaningless on a different provider.

When resolution lands on a route, each target names its own model (so `extraction.model` does not apply), the extraction call gets ordered provider failover, and it is metered against the target that actually served.

The custom `prompt` controls *what* to extract, not the response format — the server always appends the JSON-array contract line and the conversation transcript, since the extraction parser accepts nothing else.

Extraction is opt-in and requires both fields: `extraction` without `write_memory_id` does nothing. Streaming generations and `requires_action` (client-tool) turns do not trigger extraction; the turn must complete in the same request.

##### Gating extraction per turn

The agent-level `extraction` flag decides the default, but a single [`POST /agents/:id/generate`](/docs/api/agents/create-agent-generation) call can override it with a top-level `extract` boolean (not inside `knowledge_config`):

- `extract` omitted — follow the agent's stored `extraction` default.
- `extract: false` — suppress extraction for this turn even when the agent enables it. Use this for operational or tool-listing turns whose facts would only add noise to a curated memory.
- `extract: true` — force extraction for this turn even when the agent does not enable it by default, provided the agent has a `write_memory_id`.

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
