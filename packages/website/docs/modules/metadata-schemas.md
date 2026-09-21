---
description: "Declare what a resource's metadata must satisfy in a project, enforced at every write path that stores it."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Metadata Schemas

A Metadata Schema declares what a resource's `metadata` must satisfy in a project. A write whose metadata violates the declaration in force is refused by the resource's own write path.

## Overview

`metadata` is a free bag: whatever a writer attaches is what the next reader gets. That is what makes it useful, and what makes a corpus many writers share unreadable as structured data — one writer's `quarter` is another's `period`, and the reader finds out at query time.

A declaration states the structure somewhere both of them see. It names the `resource_type` it governs, the selector that type is addressed by, and a JSON Schema. [Documents](./documents.md#metadata-schemas) are selected by `path_prefix`, because a path is what a document is filed under.

**The declarations are the contract; the resources' write paths are the enforcement.** [`POST /api/v1/metadata-schemas/validate`](/docs/api/metadata-schemas/validate-metadata) reports what a write would be told, and refuses nothing: a check a writer has to call is advisory, and the writer who skips it is the one the rule exists for.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Govern Metadata with Schemas - Step 2 (Declare what a report must carry)](/docs/tutorials/govern-metadata-with-schemas#step-2--declare-what-a-report-must-carry)
- [Govern Metadata with Schemas - Step 5 (Check a batch before sending it)](/docs/tutorials/govern-metadata-with-schemas#step-5--check-a-batch-before-sending-it)

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

### A declaration is what makes the corpus orderable

A declaration types its fields, and a type is what an ordering needs: `gt`, `gte`, `lt` and `lte` in a [metadata filter](./documents.md#metadata-filters) are served on fields some declaration in the project types as `string`, `number` or `integer`. Equality and `in` need no declaration — they match the stored value exactly, which takes no type.

Two declarations typing one field differently leave it unorderable: the comparison would otherwise depend on which corner of the corpus a row came from.

### Deleting a declaration changes writes, not rows

Documents already stored keep the metadata they hold: the rule governed the writes that stored it. Tightening a schema behaves the same way — it refuses the next write of the fields it governs rather than freezing what is already there.

## Access Rules

- Declaring, changing and deleting are separate actions from reading, so an operator who governs a corpus needs no project-admin role, and a reader of the contract needs no write grant.
- Every item route authorizes against the declaration's own SRN (`srn:<project>:metadata_schema:<id>`), so a policy can name one declaration.
- An id a caller cannot read answers `404`, exactly as an id that does not exist: existence is not leaked.

## Examples

### Declare what documents under a prefix must carry

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-metadata-schema \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --resource-type document \
  --path-prefix /reports \
  --schema '{"type":"object","required":["quarter"],"properties":{"quarter":{"type":"string","enum":["Q1","Q2","Q3","Q4"]}}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await soat.metadataSchemas.createMetadataSchema({
  body: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    resource_type: 'document',
    path_prefix: '/reports',
    schema: {
      type: 'object',
      required: ['quarter'],
      properties: {
        quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'] },
      },
    },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "$SOAT_BASE_URL/api/v1/metadata-schemas" \
  -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_V1StGXR8Z5jdHi6B","resource_type":"document","path_prefix":"/reports","schema":{"type":"object","required":["quarter"],"properties":{"quarter":{"type":"string","enum":["Q1","Q2","Q3","Q4"]}}}}'
```

</TabItem>
</Tabs>

### Read what a project declares

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-metadata-schemas --project-id proj_V1StGXR8Z5jdHi6B --resource-type document
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await soat.metadataSchemas.listMetadataSchemas({
  query: { project_id: 'proj_V1StGXR8Z5jdHi6B', resource_type: 'document' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "$SOAT_BASE_URL/api/v1/metadata-schemas?project_id=proj_V1StGXR8Z5jdHi6B&resource_type=document" \
  -H "Authorization: Bearer $SOAT_TOKEN"
```

</TabItem>
</Tabs>

### Check a bag before writing it

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat validate-metadata \
  --project-id proj_V1StGXR8Z5jdHi6B \
  --path /reports/q1.txt \
  --metadata '{"owner":"finance"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await soat.metadataSchemas.validateMetadata({
  body: {
    project_id: 'proj_V1StGXR8Z5jdHi6B',
    path: '/reports/q1.txt',
    metadata: { owner: 'finance' },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "$SOAT_BASE_URL/api/v1/metadata-schemas/validate" \
  -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_V1StGXR8Z5jdHi6B","path":"/reports/q1.txt","metadata":{"owner":"finance"}}'
```

</TabItem>
</Tabs>

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

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat delete-metadata-schema --metadata-schema-id mdschema_V1StGXR8Z5jdHi6B
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await soat.metadataSchemas.deleteMetadataSchema({
  path: { metadata_schema_id: 'mdschema_V1StGXR8Z5jdHi6B' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X DELETE "$SOAT_BASE_URL/api/v1/metadata-schemas/mdschema_V1StGXR8Z5jdHi6B" \
  -H "Authorization: Bearer $SOAT_TOKEN"
```

</TabItem>
</Tabs>
