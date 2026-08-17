---
description: "Unified semantic search across a project's documents and memory entries, ranked by vector similarity and tagged by source."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Knowledge

## Overview

The Knowledge module provides unified semantic search across all knowledge sources in a project — documents and memory entries. A single endpoint searches across these sources simultaneously, ranks results by vector similarity, and returns an interleaved list tagged by source type.

Each result carries a `source_type` discriminant (`"document"` or `"memory"`) so callers know where each piece of knowledge came from. This is the same search layer agents use internally for retrieval — see it wired into an agent in [Agent with Persistent Memory — Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config), and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive for the full retrieval pipeline and its extension points.

The module follows SOAT's [engine & algorithms pattern](../getting-started/engines-and-algorithms.md): the two stores, the unified search function, and injection are the **engine**; chunking and ranking are the **algorithms**, and [ingestion rules](./ingestion-rules.md) are the seam for bringing your own extraction algorithm as a [tool](./tools.md).

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config)
- [Agent with Persistent Memory - Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly)
- [Agent over a Library of PDFs - Step 8 (Search the knowledge layer directly)](/docs/tutorials/agent-with-pdfs#step-8--search-the-knowledge-layer-directly-plan-d)
- [Agent over a Library of PDFs - Step 12 (Give the agent a knowledge tool)](/docs/tutorials/agent-with-pdfs#step-12--give-the-agent-a-knowledge-tool-plan-d)

## Data Model

### KnowledgeResult

A `KnowledgeResult` is a discriminated union on `source_type`. All results share common fields; source-specific fields are only present for the matching type.

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

The [`POST /knowledge/search`](/docs/api/knowledge/search-knowledge) endpoint accepts the following filters. At least one must be provided.

| Parameter        | Type       | Description                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `query`          | `string`   | Semantic search query — ranks results by vector similarity                                 |
| `memory_ids`     | `string[]` | Search entries within these specific memories                                              |
| `memory_tags`    | `string[]` | Match entries by tag at entry granularity: returns entries whose parent memory's tags match **or** whose own per-entry tags match any of these patterns (supports glob: `user*`) |
| `document_paths` | `string[]` | Filter document results to paths starting with these prefixes                              |
| `document_ids`   | `string[]` | Filter document results to specific document IDs                                           |

When `query` is set, results include `score` and `similarity_score` and are ordered by descending `score`; `min_score` and `limit` apply additional controls. For a walkthrough, see [Agent with Persistent Memory — Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly).

Which sources a request searches follows from its filters: document results are included whenever `query`, `document_paths`, or `document_ids` is passed; memory entries whenever `memory_ids` or `memory_tags` is passed. Passing a `query` together with a memory filter searches both sources at once — the result sets are merged and ranked together by descending similarity before `limit` is applied. `memory_ids` and `memory_tags` combine with union semantics.

`memory_tags` matches at **entry granularity**: an entry is returned when its parent memory's tags match the globs or when the entry's own `tags` match — see [Memories — Entry-Level Tag Filtering](./memories.md#entry-level-tag-filtering).

### Relevance scoring

Two fields come back on every result of a `query` search, and they are **not** the same
contract:

| Field | Contract |
| --- | --- |
| `score` | **Implementation-defined** relevance ranking, higher is better. The *ordering* it produces is the contract; the absolute value is not. Results are sorted by it and `min_score` filters on it. |
| `similarity_score` | Raw **cosine similarity** (0–1) between the query embedding and the result. Pinned to that meaning — it is never redefined. |

Today the ranking is single-signal, so the two are equal. That is an implementation
detail, not a guarantee: a later hybrid ranking would fuse several signals into `score`
while `similarity_score` keeps reporting the cosine value for debugging.

What this means in practice:

- **Compare, don't interpret.** `score` is meaningful *relative to other results in the
  same response*. Do not persist it, compare it across releases, or show it to end users
  as a percentage.
- **`min_score` is a deployment-tuned knob, not a portable constant.** It filters on
  `score`, so a threshold tuned against today's ranking is not guaranteed to select the
  same results after the ranking changes. Pin the value per deployment and re-tune it when
  you upgrade.
- **Need a stable number?** Read `similarity_score`.

### Injected knowledge is untrusted input

Retrieved knowledge is partly **user-derived** — a memory entry written by
[automatic extraction](./memories.md#automatic-extraction) contains whatever the user
said in the turn it was extracted from. The platform treats it as data, never as
instruction, and enforces that in two places:

- **It is never injected with the `system` role.** [Agent knowledge injection](./agents.md#knowledge-config)
  delivers results as a `user` message inside a fenced `<knowledge>` block, preceded by a
  preamble framing the contents as reference material. The agent's own `instructions`
  remain the only system-authored input. Without this, a phrase a user said once could
  come back as a system-level instruction in every later generation — a persistent
  escalation path, not a one-turn prompt injection.
- **Extraction runs tool-less.** The fact-extraction completion is a plain text completion
  with no tools and no knowledge injection of its own, so text quoted from a conversation
  cannot trigger an agent side effect while it is being turned into memory entries.

**What this does not do:** it does not make retrieved content safe to act on. A tool call
an agent makes after reading injected knowledge is still authorized only by that agent's
[boundary policy](./agents.md) and [guardrails](./guardrails.md) — the fencing lowers the
chance a model treats retrieved text as an instruction, it does not authorize anything.
Scope an agent's boundary policy on the assumption that anything in its reachable memories
and documents may influence what it tries to do.

### Project Scoping

`project_id` is optional. When omitted, the server resolves accessible projects from the caller's identity (API key project scope, admin wildcard, or the projects granted by the caller's policies).

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are stored (shared with Files)  |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend: `ollama`, `openai`, or `bedrock`          |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024` |
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
