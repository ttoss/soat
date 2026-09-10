---
description: "Unified semantic search across a project's documents and memory entries, ranked by vector similarity and tagged by source."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Knowledge

## Overview

Unified semantic search across a project's documents and memory entries: one endpoint, ranked by vector similarity, interleaved and tagged by source.

Each result carries `source_type` (`"document"` or `"memory"`). Agents use the same layer for retrieval: [Agent with Persistent Memory — Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config) and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive.

In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md): the two stores, the search function, and injection are the **engine**; chunking and ranking are the **algorithms**; [ingestion rules](./ingestion-rules.md) are the seam for a bring-your-own extraction [tool](./tools.md).

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config)
- [Agent with Persistent Memory - Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly)
- [Agent over a Library of PDFs - Step 8 (Search the knowledge layer directly)](/docs/tutorials/agent-with-pdfs#step-8--search-the-knowledge-layer-directly-plan-d)
- [Agent over a Library of PDFs - Step 12 (Give the agent a knowledge tool)](/docs/tutorials/agent-with-pdfs#step-12--give-the-agent-a-knowledge-tool-plan-d)

## Data Model

### KnowledgeResult

A `KnowledgeResult` is a discriminated union on `source_type`; source-specific fields appear only for the matching type.

#### Common fields (all source types)

| Field         | Type                       | Description                                              |
| ------------- | -------------------------- | -------------------------------------------------------- |
| `source_type` | `"document"` \| `"memory"` | Discriminant for the knowledge source type               |
| `content`     | `string\|null`             | Text content of the result                               |
| `score`       | `number`                   | Relevance ranking; only present when `query` is used — see [Relevance scoring](#relevance-scoring) |
| `similarity_score` | `number`              | Raw cosine similarity (0–1); only present when `query` is used |
| `created_at`  | `string`                   | ISO 8601 creation timestamp                              |
| `updated_at`  | `string`                   | ISO 8601 last-updated timestamp                          |

#### Document result (`source_type: "document"`)

| Field         | Type           | Description                                              |
| ------------- | -------------- | -------------------------------------------------------- |
| `document_id` | `string`       | Public document ID (`doc_` prefix)                       |
| `file_id`     | `string`       | ID of the underlying File record                         |
| `project_id`  | `string`       | ID of the owning project                                 |
| `path`        | `string\|null` | Logical path within the project (e.g. `/reports/q1.txt`) |
| `filename`    | `string`       | Original filename                                        |
| `size`        | `number`       | File size in bytes                                       |
| `title`       | `string\|null` | Document title (if set)                                  |
| `metadata`    | `object\|null` | Arbitrary JSON metadata, returned with keys in the exact casing they were written with — not converted between `snake_case` and `camelCase` like other fields |
| `tags`        | `object`       | Key-value tags associated with the document              |

#### Memory result (`source_type: "memory"`)

| Field         | Type     | Description                                    |
| ------------- | -------- | ---------------------------------------------- |
| `entry_id`    | `string` | Public memory entry ID (`mem_entry_` prefix)   |
| `memory_id`   | `string` | Public ID of the parent memory (`mem_` prefix) |
| `memory_name` | `string` | Human-readable name of the parent memory       |

## Key Concepts

### Search Modes

The [`POST /knowledge/search`](/docs/api/knowledge/search-knowledge) filters (at least one required):

| Parameter        | Type       | Description                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `query`          | `string`   | Semantic search query — ranks results by vector similarity                                 |
| `memory_ids`     | `string[]` | Search entries within these specific memories                                              |
| `memory_tags`    | `string[]` | Match entries by tag at entry granularity: returns entries whose parent memory's tags match **or** whose own per-entry tags match any of these patterns (supports glob: `user*`) |
| `document_paths` | `string[]` | Filter document results to paths starting with these prefixes                              |
| `document_ids`   | `string[]` | Filter document results to specific document IDs                                           |

With `query`, results carry `score` and `similarity_score`, ordered by descending `score`; `min_score` and `limit` apply. Walkthrough: [Agent with Persistent Memory — Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly).

Sources follow from the filters: documents when `query`, `document_paths`, or `document_ids` is passed; memory entries when `memory_ids` or `memory_tags` is. A `query` plus a memory filter searches both, merged and ranked by descending similarity before `limit`. `memory_ids` and `memory_tags` union.

`memory_tags` matches at **entry granularity**: an entry is returned when its parent memory's tags match the globs or when the entry's own `tags` match — see [Memories — Entry-Level Tag Filtering](./memories.md#entry-level-tag-filtering).

### Relevance scoring

Two fields on every `query` result, with different contracts:

| Field | Contract |
| --- | --- |
| `score` | **Implementation-defined** relevance ranking, higher is better. The *ordering* it produces is the contract; the absolute value is not. Results are sorted by it and `min_score` filters on it. |
| `similarity_score` | Raw **cosine similarity** (0–1) between the query embedding and the result. Pinned to that meaning — it is never redefined. |

Today the ranking is single-signal, so the two are equal; a later hybrid ranking would fuse signals into `score` while `similarity_score` keeps the cosine value.

- `score` is comparable only *within one response*. Do not persist it, compare it across releases, or show it as a percentage.
- `min_score` filters on `score`, so a threshold tuned against one ranking may not survive an upgrade; pin it per deployment and re-tune.
- For a stable number, read `similarity_score`.

### Ranking is approximate

Both vector columns carry an HNSW index, so `query` search is **approximate nearest neighbour**: it reads a bounded candidate list from the index instead of scanning every vector, keeping cost sub-linear in corpus size. The cost is exactness:

- **Recall against the true top-k is below 1.0.** A result that would rank 10th can be missed. Both fields keep their meaning; the set being ordered is not guaranteed to be the exact best k.
- **`min_score` needs re-tuning**: the candidate set feeding it changed.
- **Filters do not silently shrink the result set.** Scope, `paths`, `document_ids` and permission filters apply *after* the index proposes candidates, so a narrow scope could return fewer than `limit` rows; SOAT enables pgvector's iterative index scan on every search, widening the candidate list until `limit` is satisfied post-filter.

The last guarantee needs **pgvector 0.8 or newer** (`hnsw.iterative_scan`). On an older extension PostgreSQL discards the setting with a warning and a filtered search can come back short; see [Configuration](../self-hosting/configuration.md).

### Injected knowledge is untrusted input

Retrieved knowledge is partly **user-derived** (an entry written by [automatic extraction](./memories.md#automatic-extraction) contains what the user said). It is treated as data, never instruction:

- **Never injected with the `system` role.** [Agent knowledge injection](./agents.md#knowledge-config) delivers results as a `user` message inside a fenced `<knowledge>` block with a preamble framing it as reference material; the agent's `instructions` remain the only system input. Otherwise a phrase a user said once could become a persistent system-level instruction.
- **Extraction runs tool-less**: a plain completion with no tools and no injection, so quoted text cannot trigger a side effect while becoming memory entries.

This does not make retrieved content safe to act on: a tool call made after reading it is still authorized only by the agent's [boundary policy](./agents.md) and [guardrails](./guardrails.md). Scope the boundary policy assuming anything in reachable memories and documents may influence the agent.

### Project Scoping

`project_id` is optional; when omitted, accessible projects come from the caller's identity (API key scope, admin wildcard, or policy grants).

### Result ceiling

`limit` defaults to 10 and is clamped to **100**; a larger value returns up to 100 rows rather than being refused.

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are stored (shared with Files)  |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend: `ollama`, `openai`, or `bedrock`          |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024`, and be at most `2000` |
| `OLLAMA_BASE_URL`      | No       | Ollama server URL, defaults to `http://localhost:11434`      |

## Examples

### Semantic search across documents and memories

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --query "quarterly revenue" \
  --memory-ids mem_xyz \
  --limit 5
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.knowledge.searchKnowledge({
  body: {
    project_id: 'proj_ABC',
    query: 'quarterly revenue',
    memory_ids: ['mem_xyz'],
    limit: 5,
  },
});
if (error) throw new Error(JSON.stringify(error));
console.log(data.results);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/knowledge/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "query": "quarterly revenue",
    "memory_ids": ["mem_xyz"],
    "limit": 5
  }'
```

</TabItem>
</Tabs>

### Path-scoped document retrieval (no query)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --document-paths /docs/products/
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.knowledge.searchKnowledge({
  body: {
    project_id: 'proj_ABC',
    document_paths: ['/docs/products/'],
  },
});
if (error) throw new Error(JSON.stringify(error));
console.log(data.results);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/knowledge/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "document_paths": ["/docs/products/"]
  }'
```

</TabItem>
</Tabs>
