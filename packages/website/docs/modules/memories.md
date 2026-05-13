# Memories

## Overview

Memories are named containers for storing and organizing knowledge items (entries) within a project. They provide a logical namespace for text content, enabling structured retrieval via the [Knowledge](./knowledge.md) module. Each memory can hold many **memory entries** — individual pieces of text that are automatically embedded for semantic search.

## Key Concepts

### Memory

| Field         | Type             | Description                               |
| ------------- | ---------------- | ----------------------------------------- |
| `id`          | `string`         | Public ID (`mem_` prefix)                 |
| `project_id`  | `string`         | ID of the owning project                  |
| `name`        | `string`         | Human-readable name                       |
| `description` | `string\|null`   | Optional description                      |
| `tags`        | `string[]\|null` | Optional labels for filtering by category |
| `created_at`  | `string`         | ISO 8601 creation timestamp               |
| `updated_at`  | `string`         | ISO 8601 last-update timestamp            |

### Memory Entry

Memory entries are the individual knowledge items stored inside a memory. When an entry is created or updated, its `content` is automatically embedded using the configured embedding model. The embedding is used for semantic similarity search in the Knowledge module.

| Field        | Type     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `id`         | `string` | Public ID (`me_` prefix)                                |
| `memory_id`  | `string` | ID of the parent memory                                 |
| `content`    | `string` | Text content of the entry                               |
| `source`     | `string` | Origin of the entry: `manual`, `agent`, or `extraction` |
| `created_at` | `string` | ISO 8601 creation timestamp                             |
| `updated_at` | `string` | ISO 8601 last-update timestamp                          |

#### Sources

- **`manual`** — Default. Entry created directly by a user or API caller.
- **`agent`** — Entry written by an agent during execution.
- **`extraction`** — Entry extracted from a document or external source.

## Write Algorithm

Every write to a memory — via REST, agent tool, or extraction — goes through the same deduplication algorithm. You never need to check for duplicates yourself.

### How It Works

When you call `POST /api/v1/memories/:memoryId/entries`, the server:

1. **Embeds** the incoming content.
2. **Finds** the most similar existing entry in that memory (cosine similarity via pgvector).
3. **Decides** based on two configurable thresholds:

| Similarity range        | Decision   | What happens                                                              |
| ----------------------- | ---------- | ------------------------------------------------------------------------- |
| ≥ `duplicate_threshold` | **Skip**   | The fact is already known. Returns the existing entry unchanged.          |
| ≥ `update_threshold`    | **Merge**  | The fact overlaps. An LLM merges old and new into a single updated entry. |
| < `update_threshold`    | **Create** | The fact is new. A new entry is created.                                  |

### Request Fields

| Field                 | Type   | Default  | Description                                 |
| --------------------- | ------ | -------- | ------------------------------------------- |
| `content`             | string | —        | The fact or observation to write            |
| `source`              | string | `manual` | Origin: `manual`, `agent`, `extraction`     |
| `duplicate_threshold` | number | `0.95`   | Similarity above which the write is skipped |
| `update_threshold`    | number | `0.75`   | Similarity above which entries are merged   |

### Response

The response always includes an `action` field alongside the entry:

| `action`  | HTTP status | Meaning                                      |
| --------- | ----------- | -------------------------------------------- |
| `created` | `201`       | New entry written                            |
| `updated` | `200`       | Existing entry merged with new content       |
| `skipped` | `200`       | Duplicate detected — existing entry returned |

### Examples

**First write — new fact:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer prefers email over phone calls" }

→ 201 { "action": "created", "id": "me_001", "content": "Customer prefers email over phone calls", ... }
```

**Duplicate write — same fact rephrased:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "The customer likes email more than phone" }

→ 200 { "action": "skipped", "id": "me_001", "content": "Customer prefers email over phone calls", ... }
```

**Merge write — related fact with new detail:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer prefers email, especially for billing inquiries" }

→ 200 { "action": "updated", "id": "me_001", "content": "Customer prefers email over phone calls, especially for billing inquiries", ... }
```

**Unrelated write — genuinely new fact:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer fiscal year ends in March" }

→ 201 { "action": "created", "id": "me_002", "content": "Customer fiscal year ends in March", ... }
```

## Permissions

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Agent Integration

Agents can read from and write to memories automatically during generation.

### Automatic Knowledge Retrieval

Set `knowledge_config` on an agent to have the server search relevant memory entries before every generation and inject them as system messages:

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_abc"],
    "memory_tags": ["customer*"],
    "min_score": 0.6,
    "limit": 5
  }
}
```

Before each generation the server embeds the latest user message, runs `searchKnowledge` with the merged config, and prepends results like:

```
[Memory: Customer Preferences] Customer prefers email over phone calls, especially for billing inquiries
[Memory: Customer Preferences] Customer fiscal year ends in March
```

See the [Agents module](./agents.md#knowledge-config) for the full `knowledge_config` reference and merge semantics.

### `write_memory` Agent Tool

Agents can write new facts to a memory during generation using the `write_memory` soat-tool. This tool is automatically available when the agent's `knowledge_config` includes at least one `memory_id`.

The tool takes two inputs:

| Input      | Type   | Description                                    |
| ---------- | ------ | ---------------------------------------------- |
| `memoryId` | string | ID of the target memory (`mem_` prefix)        |
| `content`  | string | The fact or observation to write to the memory |

The write goes through the standard [deduplication algorithm](#write-algorithm) — the agent never produces duplicate entries.

To enable the tool, attach a `soat` tool with the `memories:WriteMemoryEntry` action to the agent:

```json
{
  "type": "soat",
  "name": "memory-tools",
  "actions": ["memories:WriteMemoryEntry"]
}
```

When the agent's `knowledge_config.memory_ids` is set, the server also injects the memory IDs as preset parameters so the agent always writes to the correct memory without needing to specify it explicitly.
