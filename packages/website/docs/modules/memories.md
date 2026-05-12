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

## Permissions

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.
