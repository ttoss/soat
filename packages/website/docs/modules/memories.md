# Memories

## Overview

Memories are named, reusable document-retrieval configurations. Each memory stores a `config` object that describes _how_ to retrieve documents from the project's file corpus — which documents to consider, how to rank them, and how many to return. At query time, callers invoke `POST /memories/:memory_id/search` and receive the matching documents.

Memories enable RAG (Retrieval-Augmented Generation) workflows by decoupling the retrieval logic from the calling agent or chat session.

## Key Concepts

### Memory Entity

| Field         | Type           | Description                         |
| ------------- | -------------- | ----------------------------------- |
| `id`          | `string`       | Public ID (`mem_` prefix)           |
| `project_id`  | `string`       | ID of the owning project            |
| `name`        | `string`       | Human-readable name                 |
| `description` | `string\|null` | Optional description                |
| `config`      | `MemoryConfig` | Retrieval configuration (see below) |
| `created_at`  | `string`       | ISO 8601 creation timestamp         |
| `updated_at`  | `string`       | ISO 8601 last-update timestamp      |

### MemoryConfig

The `config` object controls which documents are retrieved and how they are ranked. At least one of `search`, `paths`, or `document_ids` must be provided when creating a memory.

| Field          | Type       | Description                                                                |
| -------------- | ---------- | -------------------------------------------------------------------------- |
| `search`       | `string`   | Semantic search query; when set, documents are ranked by vector similarity |
| `min_score`    | `number`   | Minimum relevance score (0–1); only applied when `search` is set           |
| `limit`        | `integer`  | Maximum number of documents to return (default: 10)                        |
| `paths`        | `string[]` | Filter to files whose path starts with one of these prefixes               |
| `document_ids` | `string[]` | Filter to specific document IDs                                            |

### Search Behavior

`POST /memories/:memory_id/search` accepts an optional request body of the same `MemoryConfig` shape. Any fields in the body **override** the corresponding fields in the stored `config` for that request only — the stored config is not modified.

Example: a memory may store `{ "paths": ["docs/"] }` and a caller overrides it at search time with `{ "search": "password reset" }` to add semantic ranking while keeping the path filter.

## Example Configurations

**Semantic search across all project documents:**

```json
{
  "search": "How do I reset my password?",
  "min_score": 0.7,
  "limit": 5
}
```

**Path-scoped retrieval (no semantic ranking):**

```json
{
  "paths": ["docs/products/"],
  "limit": 20
}
```

**Combined semantic + path filter:**

```json
{
  "search": "billing FAQ",
  "paths": ["docs/support/"],
  "min_score": 0.6,
  "limit": 10
}
```

## Permissions

| Action                  | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `memories:ListMemories` | List all memory configurations in a project         |
| `memories:CreateMemory` | Create a new memory configuration                   |
| `memories:GetMemory`    | Read a single memory configuration (and run search) |
| `memories:UpdateMemory` | Update a memory configuration                       |
| `memories:DeleteMemory` | Delete a memory configuration                       |

The `searchMemory` operation (`POST /memories/:memory_id/search`) reuses the `memories:GetMemory` action — any principal that can read a memory can also invoke its search.
