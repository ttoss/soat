---
description: "Declare what a resource's metadata must satisfy in a project, enforced at every write path that stores it."
---

# Metadata Schemas

A Metadata Schema declares what a resource's `metadata` must satisfy in a project. A write whose metadata violates the declaration in force is refused by the resource's own write path.

## Overview

`metadata` is a free bag: whatever a writer attaches is what the next reader gets. That is what makes it useful, and what makes a corpus many writers share unreadable as structured data — one writer's `quarter` is another's `period`, and the reader finds out at query time.

A declaration states the structure somewhere both of them see. It names the `resource_type` it governs, the selector that type is addressed by, and a JSON Schema. [Documents](./documents.md#metadata-schemas) are selected by `path_prefix`, because a path is what a document is filed under.

**The declarations are the contract; the resources' write paths are the enforcement.** [`POST /api/v1/metadata-schemas/validate`](/docs/api/metadata-schemas/validate-metadata) reports what a write would be told, and refuses nothing: a check a writer has to call is advisory, and the writer who skips it is the one the rule exists for.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier prefixed with `mdschema_` |
| `project_id` | string | The project whose writes the declaration governs |
| `resource_type` | string | The resource governed. `document` today; a type appears here once its write path reads the registry |
| `path_prefix` | string | The selector, in the field its resource type is addressed by. A document's is the directory it governs |
| `schema` | object | A JSON Schema, stored as written — its keywords are its own vocabulary and are never case-converted |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last-updated timestamp |

## Key Concepts

### A declaration is a row

One selector has one schema per resource type, held by a unique index, so two operators governing different corners of a corpus write independently and a second declaration of the same selector is `409 NAME_CONFLICT` rather than a silent overwrite.

`resource_type` is fixed at creation: it decides the selector's spelling and which write path reads the row, so changing it would repoint the declaration at a different door. Delete it and declare again instead.

### A type is declarable once it is enforced

`resource_type` accepts only the types whose write path reads the registry. A declaration for any other is `400 VALIDATION_FAILED` — one that governed nothing would be worse than none, because its author would believe a rule was in force.

### A broken schema is never stored

The schema is compiled when it is declared, and one JSON Schema cannot parse is refused. A stored one would be a rule that silently governs nothing, and the author would never learn it does not.

### Deleting a declaration changes writes, not rows

Documents already stored keep the metadata they hold: the rule governed the writes that stored it. Tightening a schema behaves the same way — it refuses the next write of the fields it governs rather than freezing what is already there.

## Access Rules

- Declaring, changing and deleting are separate actions from reading, so an operator who governs a corpus needs no project-admin role, and a reader of the contract needs no write grant.
- Every item route authorizes against the declaration's own SRN (`srn:<project>:metadata_schema:<id>`), so a policy can name one declaration.
- An id a caller cannot read answers `404`, exactly as an id that does not exist: existence is not leaked.

## Examples

### Declare what documents under a prefix must carry

```bash
soat create-metadata-schema \
  --project_id proj_abc \
  --resource_type document \
  --path_prefix /reports \
  --schema '{"type":"object","required":["quarter"],"properties":{"quarter":{"type":"string","enum":["Q1","Q2","Q3","Q4"]}}}'
```

### Check a bag before writing it

```bash
soat validate-metadata \
  --project_id proj_abc \
  --path /reports/q1.txt \
  --metadata '{"owner":"finance"}'
```

```json
{
  "valid": false,
  "resource_type": "document",
  "metadata_schema_id": "mdschema_V1StGXR8Z5jdHi6B",
  "path_prefix": "/reports",
  "error": "(root) must have required property 'quarter'"
}
```

### Stop governing a prefix

```bash
soat delete-metadata-schema --metadata-schema-id mdschema_V1StGXR8Z5jdHi6B
```
