import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Knowledge

## Overview

The Knowledge module provides unified semantic search across documents in a project. It replaces the former per-module search endpoints with a single endpoint that can search documents by semantic query, logical path prefix, or explicit document IDs.

Each result is tagged with a `source_type` discriminant (`"document"`) to prepare for future knowledge sources (e.g., memory entries).

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### KnowledgeResult

| Field         | Type           | Description                                              |
| ------------- | -------------- | -------------------------------------------------------- |
| `source_type` | `"document"`   | Discriminant for the knowledge source type               |
| `document_id` | `string`       | Public document ID (`doc_` prefix)                       |
| `file_id`     | `string`       | ID of the underlying File record                         |
| `project_id`  | `string`       | ID of the owning project                                 |
| `path`        | `string\|null` | Logical path within the project (e.g. `/reports/q1.txt`) |
| `filename`    | `string`       | Original filename                                        |
| `size`        | `number`       | File size in bytes                                       |
| `title`       | `string\|null` | Document title (if set)                                  |
| `metadata`    | `object\|null` | Arbitrary JSON metadata                                  |
| `tags`        | `string[]`     | Tags associated with the document                        |
| `content`     | `string\|null` | Text content of the document                             |
| `score`       | `number`       | Relevance score (0–1); only present when `query` is used |
| `created_at`  | `string`       | ISO 8601 creation timestamp                              |
| `updated_at`  | `string`       | ISO 8601 last-updated timestamp                          |

## Key Concepts

### Search Modes

The `POST /knowledge/search` endpoint supports three complementary filters that can be combined:

| Parameter      | Type       | Description                                                |
| -------------- | ---------- | ---------------------------------------------------------- |
| `query`        | `string`   | Semantic search query — ranks results by vector similarity |
| `paths`        | `string[]` | Filter to documents at paths starting with these prefixes  |
| `document_ids` | `string[]` | Filter to specific document IDs                            |

At least one of `query`, `paths`, or `document_ids` must be provided.

When `query` is set, results include a `score` field and are ordered by descending relevance. `min_score` and `limit` apply additional controls.

### Project Scoping

`project_id` is optional. When omitted, the server resolves accessible projects from the caller's identity (API key project scope, admin wildcard, or explicit project memberships).

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are stored (shared with Files)  |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend — only `ollama` is supported               |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024` |
| `OLLAMA_BASE_URL`      | No       | Ollama server URL, defaults to `http://localhost:11434`      |

## Examples

### Semantic search across a project

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --query "quarterly revenue" \
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
  body: { project_id: 'proj_ABC', query: 'quarterly revenue', limit: 5 },
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
    "limit": 5
  }'
```

</TabItem>
</Tabs>

### Path-scoped retrieval

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge \
  --project-id proj_ABC \
  --paths /docs/products/
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/knowledge/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "paths": ["/docs/products/"]
  }'
```

</TabItem>
</Tabs>
