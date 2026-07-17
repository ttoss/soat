---
description: "Unified semantic search across a project's documents and memory entries, ranked by vector similarity and tagged by source."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Knowledge

## Overview

The Knowledge module provides unified semantic search across all knowledge sources in a project — documents and memory entries. A single endpoint searches across these sources simultaneously, ranks results by vector similarity, and returns an interleaved list tagged by source type.

Each result carries a `source_type` discriminant (`"document"` or `"memory"`) so callers know where each piece of knowledge came from. This is the same search layer agents use internally for retrieval — see it wired into an agent in [Agent with Persistent Memory — Step 8 (Create an agent with knowledge_config)](/docs/tutorials/memories-agent#step-8--create-an-agent-with-knowledge_config).

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
| `similarity_score` | `number`              | Semantic similarity score (0–1); only present when `query` is used |
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

The `POST /knowledge/search` endpoint accepts the following filters. At least one must be provided.

| Parameter        | Type       | Description                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `query`          | `string`   | Semantic search query — ranks results by vector similarity                                 |
| `memory_ids`     | `string[]` | Search entries within these specific memories                                              |
| `memory_tags`    | `string[]` | Match entries by tag at entry granularity: returns entries whose parent memory's tags match **or** whose own per-entry tags match any of these patterns (supports glob: `user*`) |
| `document_paths` | `string[]` | Filter document results to paths starting with these prefixes                              |
| `document_ids`   | `string[]` | Filter document results to specific document IDs                                           |

When `query` is set, results include a `similarity_score` field and are ordered by descending relevance. `min_score` and `limit` apply additional controls. For a walkthrough that passes both `memory_ids` and `document_paths` and inspects the interleaved, scored results, see [Agent with Persistent Memory — Step 12 (Query the knowledge layer directly)](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly).

Which sources a request searches follows from which filters it carries, and the single endpoint can span both at once. Document results are included whenever you pass a `query`, `document_paths`, or `document_ids`; memory entries are included whenever you pass `memory_ids` or `memory_tags`. To search both sources simultaneously and get the interleaved, source-tagged list described in the [Overview](#overview), pass a `query` **together with** `memory_ids` or `memory_tags` — the two source sets are then merged and, when `query` is set, ranked together by descending similarity before `limit` is applied.

`memory_ids` and `memory_tags` can be combined — the search includes entries from memories matching **either** (union semantics).

`memory_tags` matches at **entry granularity**: an entry is returned when its parent memory's tags match the globs (container-level — every entry in that memory) or when the entry's own `tags` match (only that entry). Tagging entries individually (see [Memories — Entry-Level Tag Filtering](./memories.md#entry-level-tag-filtering)) lets one memory hold many roles/sources and retrieve just the relevant slice.

### Project Scoping

`project_id` is optional. When omitted, the server resolves accessible projects from the caller's identity (API key project scope, admin wildcard, or the projects granted by the caller's policies).

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are stored (shared with Files)  |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend — only `ollama` is supported               |
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

### Memory-only search by tag

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --query "customer communication" \
  --memory-tags "customer*"
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
    query: 'customer communication',
    memory_tags: ['customer*'],
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
    "query": "customer communication",
    "memory_tags": ["customer*"]
  }'
```

</TabItem>
</Tabs>

### Document-scoped retrieval

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --query "quarterly revenue" \
  --document-ids doc_xyz \
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
    document_ids: ['doc_xyz'],
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
    "document_ids": ["doc_xyz"],
    "limit": 5
  }'
```

</TabItem>
</Tabs>

### Path-scoped document retrieval

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
