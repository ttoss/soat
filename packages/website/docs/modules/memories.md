---
description: 'Memory stores and the memories they hold: the facts an agent learns, retrieves and writes back.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Memories

A **memory** is one fact an agent knows. A **memory store** is the named container that holds many of them.

## Overview

A memory store is a namespace for text content that agents read and write during generation. Each store holds many **memories**, embedded for semantic search via the [Knowledge](./knowledge.md) module.

Agents retrieve relevant memories via `knowledge_config` and write new facts with the built-in `write_memory` tool; see [Agent Integration](#agent-integration) and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive. In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md), the write funnel, embedding, provenance and invalidation are the **engine**; the [write algorithm](#write-algorithm) and [extraction](#automatic-extraction) are the **algorithms**, with customization seams in the [deep dive](../advanced/memory-and-knowledge-engine.md#extending-the-engine-today).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 4 (Create a memory store)](/docs/tutorials/memories-agent#step-4--create-a-memory-store)
- [Agent with Persistent Memory - Step 5 (Write memories)](/docs/tutorials/memories-agent#step-5--write-memories)
- [Agent with Persistent Memory - Step 10 (Observe the agent writing to memory)](/docs/tutorials/memories-agent#step-10--observe-the-agent-writing-to-memory)
- [Agent with Persistent Memory - Step 11 (Enable automatic extraction)](/docs/tutorials/memories-agent#step-11--enable-automatic-extraction)
- [Agent with Persistent Memory - Step 13 (Trace a fact back to the conversation it came from)](/docs/tutorials/memories-agent#step-13--trace-a-fact-back-to-the-conversation-it-came-from)

## Data Model

### Memory Store

| Field         | Type              | Description                               |
| ------------- | ----------------- | ----------------------------------------- |
| `id`          | `string`          | Public ID (`mstore_` prefix)              |
| `project_id`  | `string`          | ID of the owning project                  |
| `name`        | `string`          | Human-readable name                       |
| `description` | `string \| null`  | Optional description                      |
| `tags`        | `object \| null`  | Optional key-value labels for filtering by category |
| `created_at`  | `string`          | ISO 8601 creation timestamp               |
| `updated_at`  | `string`          | ISO 8601 last-updated timestamp           |

### Memory

When a memory is created or updated, its `content` is embedded for semantic similarity search.

| Field        | Type     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `id`         | `string` | Public ID (`mem_` prefix)                               |
| `memory_store_id` | `string` | ID of the parent memory store                      |
| `content`    | `string` | Text content of the memory                              |
| `source_type` | `string` | Whether there is a source to point at: `manual` (default) or `conversation` — see [Provenance](#provenance) |
| `source_id`  | `string \| null` | The [conversation](./conversations.md) this fact was learned in when `source_type` is `conversation`; `null` when `manual` |
| `tags`       | `object \| null`   | Per-memory key-value labels for memory-granularity tag filtering in [Knowledge search](./knowledge.md) |
| `metadata`   | `object \| null`   | Arbitrary structured metadata attached to the memory    |
| `invalidated_at` | `string \| null` | When the memory was superseded; `null` means currently valid — see [Temporal invalidation](#temporal-invalidation) |
| `superseded_by_memory_id` | `string \| null` | The memory that replaced this one, when superseded |
| `created_at` | `string` | ISO 8601 creation timestamp                             |
| `updated_at` | `string` | ISO 8601 last-updated timestamp                         |

## Key Concepts

### What belongs in a memory

A memory is a **fact the agent learns about the world** (a customer's shipping
address, a decision a team reached, a constraint discovered while working), retrieved by
semantic similarity and consumed as context.

Retrieval is **approximate**: `memories.embedding` carries an HNSW index, so a
similarity search reads a bounded candidate list rather than scanning every memory. Recall
against the exact top-k is below 1.0, and `min_similarity` thresholds tuned against an
exact scan may select a slightly different set. See
[Ranking is approximate](./knowledge.md#ranking-is-approximate); it applies to memory
search and to the consolidation similarity check below alike.

A **correction to the agent's behavior** ("never quote a delivery date without checking
stock") is doctrine, not a fact, and its application must not depend on retrieval rank.
It has two homes:

- **A constraint that must never be violated** — a [guardrail](./guardrails.md) `deny`,
  which refuses the action deterministically.
- **Guidance the model should follow** — the agent's `instructions`, which
  [agent versions](./agents.md#versioning-and-staged-rollout) archive on every write.

When the same correction keeps being made by hand, the
[approvals recurrence view](./approvals.md#recurrence-view) surfaces it.

### Write Algorithm

Every write to a memory store (REST, agent tool, or extraction) goes through the same deduplication algorithm.

On [`POST /api/v1/memories`](/docs/api/memories/create-memory) (with `memory_store_id` in the body), the server:

1. **Embeds** the incoming content.
2. **Finds** the most similar **currently-valid** existing memory in that store (cosine similarity via pgvector). [Invalidated memories](#temporal-invalidation) are never candidates.
3. **Decides** based on two configurable thresholds:

| Similarity range        | Decision   | What happens                                                      |
| ----------------------- | ---------- | ----------------------------------------------------------------- |
| ≥ `duplicate_threshold` | **Skip**   | The fact is already known. Returns the existing memory unchanged. |
| below it                | **Create** | A new memory is written.                                          |

`duplicate_threshold` is a per-request field on [`POST /api/v1/memories`](/docs/api/memories/create-memory), defaulting to `0.95`.

**Merge** is a third outcome, reachable only from agent write paths. A write made during a
generation (the [`write_memory` tool](#write_memory-tool) and
[automatic extraction](#automatic-extraction)) carries an agent context, so a fact scoring
at or above `0.75` but below `duplicate_threshold` is consolidated with the existing memory
into a **single atomic fact** by the agent's LLM, contradictions resolving in favour of the
new fact.

A write with no agent context (the manual endpoint) creates instead.
Consolidation is best-effort: if the completion fails or comes back empty, the write
creates too. Nothing is ever appended to an existing memory, so no write can lose a fact;
a near-duplicate pair is possible and is merged by future arbitration.

On a **merge**, the incoming `tags` and `metadata` are both shallow-merged into the existing memory (incoming keys win). [`PUT /api/v1/memories/:id`](/docs/api/memories/update-memory) replaces `tags`/`metadata` outright; pass `null` (or `{}` for tags) to clear.

#### Response `action` Field

The response always includes an `action` field alongside the memory:

| `action`  | HTTP status | Meaning                                      |
| --------- | ----------- | -------------------------------------------- |
| `created` | `201`       | New memory written                           |
| `updated` | `200`       | Existing memory rewritten to absorb the incoming fact. Agent write paths only — the manual endpoint never returns it |
| `skipped` | `200`       | Duplicate detected — existing memory returned |
| `superseded` | `200`    | The incoming fact contradicted an existing memory, which was invalidated and replaced. Produced by the LLM-arbitrated write path, which has not shipped yet — the value is part of the API contract so clients can handle it from day one. |

### Provenance

`source_type` answers one question: **is there a source to point at?**

| `source_type`  | `source_id`                        | Written by |
| -------------- | ---------------------------------- | ---------- |
| `conversation` | the conversation's public ID       | [Automatic extraction](#automatic-extraction) on a conversation turn |
| `manual`       | `null`                             | [`POST /api/v1/memories`](/docs/api/memories/create-memory), the [`write_memory` tool](#write_memory-tool), and extraction on a direct agent generation |

It deliberately does **not** describe the write *mechanism*. A fact the `write_memory`
tool wrote during a generation that belongs to no conversation reads `manual`, because
there is nothing to name — not because a human typed it.

Provenance is recorded **when the memory is created and never rewritten by a later merge**;
a turn that replaces the fact supersedes it with a new memory carrying its own provenance.

`source_id` is a loose pointer, not a foreign key: deleting the conversation leaves the id
in place. The fact *was* learned there, and the record of where it came from outlives its
source.

See [Agent with Persistent Memory - Step 13 (Trace a fact back to the conversation it came from)](/docs/tutorials/memories-agent#step-13--trace-a-fact-back-to-the-conversation-it-came-from).

### Temporal invalidation

A memory that no longer holds is **retired rather than rewritten**: superseding sets
`invalidated_at` and points `superseded_by_memory_id` at the replacement. `DELETE` remains
the way to remove a memory outright.

Invalidated memories are excluded from:

- memory listing ([`GET /api/v1/memories`](/docs/api/memories/list-memories)) unless `include_invalidated=true` is passed
- [write deduplication](#write-algorithm) — a retired fact is never a merge target, so
  restating superseded knowledge creates a new memory
- [Knowledge search](./knowledge.md), so a retired fact is never injected into a generation

They stay readable by ID ([`GET /api/v1/memories/{memory_id}`](/docs/api/memories/get-memory)) for audit.

The write path that *produces* an invalidation (LLM arbitration over a shortlist of
similar memories) has not shipped yet; the columns and API shape are in place because
supersede history cannot be reconstructed after the fact.

### Tag Filtering

Tags are free-form strings attached to a memory store at creation or update time.

```json
POST /api/v1/memory-stores
{
  "project_id": "proj_abc",
  "name": "Customer Preferences",
  "tags": { "domain": "customer", "system": "crm" }
}
```

Tags are key-value pairs, the same shape documents, actors, files, conversations and sessions carry, and the shape the IAM `soat:ResourceTag/<key>` condition reads.

The `tags` query parameter on [`GET /api/v1/memory-stores`](/docs/api/memory-stores/list-memory-stores) filters by pair, written `key:value` in the query string:

```bash
# every pair must match, exactly and case-sensitively
GET /api/v1/memory-stores?tags=domain:customer&tags=system:crm
```

The split is on the **first** colon, so a value may contain colons of its own (`url:https://example.com`). Repeat the parameter for several pairs; **all** must be present. A value with no colon is rejected rather than guessed at.

The tag map is also its own sub-resource — [`GET /api/v1/memory-stores/:id/tags`](/docs/api/memory-stores/get-memory-store-tags), [`PUT /api/v1/memory-stores/:id/tags`](/docs/api/memory-stores/replace-memory-store-tags) (replace) and [`PATCH /api/v1/memory-stores/:id/tags`](/docs/api/memory-stores/merge-memory-store-tags) (merge) — the same three routes every tagged resource exposes. All three return the tag map, not the store. See [IAM — Tags](./iam.md#tags).

### Tag Conditions

A policy condition on `soat:ResourceTag/<key>` reads these tags, so access can be granted by attribute rather than by id. Both bags take part, at the level that owns them:

| Surface | What the condition reads |
|---|---|
| [`GET /api/v1/memory-stores`](/docs/api/memory-stores/list-memory-stores), and every single-store route | the store's own tags |
| [`GET /api/v1/memories`](/docs/api/memories/list-memories) | the owning store's tags to reach the listing at all, then each memory's own tags to narrow it |
| A single memory, and the memory tag sub-routes | the memory's own tags **and** its store's — both must permit |
| [Knowledge search](./knowledge.md) | the same pair, compiled into the query: a memory is returned only when its store and itself are both permitted |

A memory is therefore never more visible than the store holding it: a condition that hides a store hides its memories, whatever they carry. A resource with no tag at all satisfies `StringNotEquals` — an absent key is not the excluded value — so untagged stores and memories stay visible under a `StringNotEquals` rule.

Walk it end to end in [Tag-Based Access Control](../tutorials/tag-based-access-control.md).

### Memory-Level Tag Filtering

Memories carry their own `tags` (and optional `metadata`), independent of the store's tags. [`GET /api/v1/memories`](/docs/api/memories/list-memories) filters them with the same `?tags=key:value` parameter, and [`GET /api/v1/memories/:id/tags`](/docs/api/memories/get-memory-tags), [`PUT /api/v1/memories/:id/tags`](/docs/api/memories/replace-memory-tags) and [`PATCH /api/v1/memories/:id/tags`](/docs/api/memories/merge-memory-tags) manage the bag without touching `content`. `tags` in [Knowledge search](./knowledge.md) and an agent's `knowledge_config.tags` match at **memory granularity**: a memory is returned when its parent store's tags contain the pairs (store-level, all its memories returned) **or** its own tags do (only that memory returned). A single store can thus hold memories for many roles/sources: tag captured rules with `role: traffic-manager` and `source: rejected_approval`, then search `tags: { "role": "traffic-manager" }` to read only those.

```bash
soat create-memory \
  --memory-store-id mstore_01 \
  --content "Reject refunds above $500 for the traffic-manager role" \
  --tags '{"role": "traffic-manager", "source": "rejected_approval"}' \
  --metadata '{"evidence": "high"}'
```

### Agent Integration

#### Automatic Knowledge Retrieval

Set `knowledge_config` on an agent to have the server search relevant memories before every generation and inject them as a delimited reference-context message (never as `system` content, since memories can be user-derived). See [Knowledge Config](./agents.md#knowledge-config).

#### `write_memory` Tool

Set `write_memory_store_id` in the agent's `knowledge_config` to inject a `write_memory` tool into every generation. The tool accepts a single `content` input, the atomic fact to write. The target store is fixed by `write_memory_store_id`; the agent cannot choose another. Memories written by the tool carry `source_type: "manual"` — the tool runs inside a generation that may belong to no conversation, so there is no source to name.

```json
{
  "knowledge_config": {
    "memory_store_ids": ["mstore_alice"],
    "write_memory_store_id": "mstore_alice"
  }
}
```

#### Automatic Extraction

Set `extraction` alongside `write_memory_store_id` to have the server extract facts from completed generation turns without an explicit `write_memory` call. Pass `true` for the defaults, or an object to customize the provider, model, and prompt:

```json
{
  "knowledge_config": {
    "write_memory_store_id": "mstore_alice",
    "extraction": true
  }
}
```

- After a conversation, session, or direct agent generation completes, the server runs a fire-and-forget extraction step that never blocks or fails the generation response.
- The step sends the turn's transcript as a plain completion (no tools, no knowledge injection) and asks for a JSON array of atomic facts. Transient content such as greetings is skipped.
- Each candidate fact (at most 20 per turn) goes through the standard [write algorithm](#write-algorithm). Memories from a conversation turn carry `source_type: "conversation"` and its id in `source_id`; a direct agent generation has no conversation, so those read `manual`.
- A summary (`{ candidates, created, updated, skipped }`) is recorded on the originating generation's `extraction` field ([Generations](./generations.md) API).

Object form fields (all optional):

| Field            | Default                  | Description                                                                                              |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `enabled`        | `true`                   | Set `false` to keep the configuration but disable extraction                                              |
| `ai_provider_id` | agent's provider         | Provider override for extraction calls — must belong to the agent's project                               |
| `model`          | see below                | Model override for extraction calls                                                                       |
| `prompt`         | built-in instructions    | Replaces the default task instructions; the JSON response contract and the transcript are always appended |

Provider resolution order: `extraction.ai_provider_id` → the agent's pinned provider → the agent's [`model_route_id`](./model-routes.md) → the project's [`default_model_route_id`](./model-routes.md#project-default-route). Model resolution for the provider cases: `extraction.model` → the override provider's `default_model` (when `ai_provider_id` is set) → the agent's `model` → the agent provider's `default_model`. A provider override falls back to *that* provider's default because the agent's model name is usually meaningless on a different provider.

When resolution lands on a route, each target names its own model (so `extraction.model` does not apply), the extraction call gets ordered provider failover, and it is metered against the target that served.

The custom `prompt` controls *what* to extract, not the response format; the server always appends the JSON-array contract line and the transcript.

Extraction requires both fields: `extraction` without `write_memory_store_id` does nothing. Streaming generations and `requires_action` (client-tool) turns do not trigger extraction; the turn must complete in the same request.

##### Gating extraction per turn

A single [`POST /agents/:id/generate`](/docs/api/agents/create-agent-generation) call can override the agent-level `extraction` default with a top-level `extract` boolean (not inside `knowledge_config`):

- `extract` omitted — follow the agent's stored `extraction` default.
- `extract: false` — suppress extraction for this turn (e.g. operational or tool-listing turns whose facts would add noise).
- `extract: true` — force extraction for this turn, provided the agent has a `write_memory_store_id`.

The `extract` flag has no effect on streaming or `requires_action` turns, and `extract: true` is a no-op when the agent has no `write_memory_store_id`.

Extraction reads the agent's stored `knowledge_config` at generation time and normalizes its casing on read, so an agent deployed by a Formation (whose stored config may be snake_case) extracts correctly without being re-saved.

See [Agent with Persistent Memory - Step 11 (Enable automatic extraction)](/docs/tutorials/memories-agent#step-11--enable-automatic-extraction).

## Examples

### Create a memory store

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-store \
  --project-id proj_ABC \
  --name "Customer Preferences" \
  --tags '{"domain": "customer", "system": "crm"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.memoryStores.createMemoryStore({
  body: {
    project_id: 'proj_ABC',
    name: 'Customer Preferences',
    tags: { domain: 'customer', system: 'crm' },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/memory-stores \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Customer Preferences",
    "tags": { "domain": "customer", "system": "crm" }
  }'
```

</TabItem>
</Tabs>

### Write a memory

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --memory-store-id mstore_01 \
  --content "Customer prefers email over phone calls"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.memories.createMemory({
  body: { memory_store_id: 'mstore_01', content: 'Customer prefers email over phone calls' },
});
if (error) throw new Error(JSON.stringify(error));
// data.action is "created", "updated", or "skipped"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/memories \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"memory_store_id": "mstore_01", "content": "Customer prefers email over phone calls"}'
```

</TabItem>
</Tabs>
