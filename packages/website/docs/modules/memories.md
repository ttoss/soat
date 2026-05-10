# Memories

## Overview

Memories are named containers for grouping related documents within a project. They provide a logical namespace for organizing document collections, enabling structured retrieval via the [Knowledge](./knowledge.md) module.

## Key Concepts

### Memory Entity

| Field         | Type           | Description                    |
| ------------- | -------------- | ------------------------------ |
| `id`          | `string`       | Public ID (`mem_` prefix)      |
| `project_id`  | `string`       | ID of the owning project       |
| `name`        | `string`       | Human-readable name            |
| `description` | `string\|null` | Optional description           |
| `created_at`  | `string`       | ISO 8601 creation timestamp    |
| `updated_at`  | `string`       | ISO 8601 last-update timestamp |

## Permissions

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.
