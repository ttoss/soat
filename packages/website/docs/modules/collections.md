---
description: "Store application data as keyed JSON items, filtered by data and tags and written under optimistic concurrency."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Collections

A Collection holds JSON items addressed by a key you choose: application data an agent or an integration reads and writes, with no embedding and no backing file.

## Overview

Use a collection for records that are looked up and filtered, not searched by meaning: tickets, orders, a user's preferences. Each item is one JSON object under a key unique in its collection. A [document](./documents.md) or a [memory](./memories.md) is the right home for text that should be found by similarity.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Collection

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Public identifier prefixed with `coll_` |
| `project_id` | string | The project the collection belongs to |
| `name` | string | Unique within the project |
| `schema` | object \| null | A JSON Schema every item's `data` must satisfy, stored as written |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last-updated timestamp |

### Item

| Field | Type | Description |
| --- | --- | --- |
| `collection_id` | string | The collection holding the item |
| `key` | string | 1–256 letters, digits and `. _ : @ -`, starting with a letter or digit; unique in the collection |
| `data` | object | The item's JSON object, at most 64 KB serialized. Stored as `jsonb`, so key order is not kept |
| `tags` | object | String key-value pairs; see [Tags](#tags) |
| `version` | integer | Starts at `1`; every write bumps it |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last-updated timestamp |

An item has no `actor_id`: link one as `data.actor_id`, or as a tag when a policy should scope by it.

## Key Concepts

### Put, merge, delete

[`PUT /api/v1/collections/{collection_id}/items/{key}`](/docs/api/collections/put-collection-item) creates the item (`201`) or replaces its `data` (`200`). [`PATCH /api/v1/collections/{collection_id}/items/{key}`](/docs/api/collections/update-collection-item) applies a JSON Merge Patch (RFC 7386) to `data`: an object merges key by key, `null` removes a key, any other value replaces it. Both replace `tags` when the body carries them and leave them alone when it does not; `null` clears them.

### Optimistic concurrency

A write states the version it read as `If-Match` or `expected_version`; an item at another version refuses it with `409 VERSION_CONFLICT` and `meta.current_version`. Without one, concurrent writes to one item still serialize, and the loser is refused the same way. A precondition on a free key is `404`: it names a version of an item that does not exist. See [Concurrent Writes](../advanced/concurrent-writes.md).

### Schema

A collection's `schema` is compiled when it is written, so one that cannot compile is `400` rather than stored. Every put and merge is judged against it (`400 VALIDATION_FAILED`, naming the failing field). Changing the schema governs the next write of each item; stored items are not re-judged.

### Filtering

[`GET /api/v1/collections/{collection_id}/items`](/docs/api/collections/list-collection-items) returns items in key order, at most 100 a page.

- `?data=` is the [structured filter grammar](./documents.md#metadata-filters) over `data`, as JSON: equality and `in` are answered by a GIN index; `gt`, `gte`, `lt`, `lte` work on any top-level field.
- `?tags=key:value` narrows by tags.

A listing runs under a statement timeout (`COLLECTION_QUERY_TIMEOUT_MS`); one that runs past it is `422 QUERY_TIMEOUT`. Add an equality condition so the index narrows what a range is evaluated on.

### Tags

Items carry `tags`, read and written through [`GET /api/v1/collections/{collection_id}/items/{key}/tags`](/docs/api/collections/get-collection-item-tags) and its `PUT` and `PATCH`, and filtered with `?tags=`. A tag write bumps the item's `version`.

### Storage

Item bytes (`data`, `key`, `tags`) count toward the project's [`gb_day`](./usage.md#storage-metering) sample, and a `storage_bytes` [quota](./quotas.md#storage-enforcement) refuses a put or merge over the cap with `409 QUOTA_STORAGE_EXCEEDED`. Reads are not billed; a project `requests` [quota](./quotas.md) bounds their rate with `429 QUOTA_EXCEEDED`.

## Access Rules

- Collection routes authorize against `srn:<project>:collection:<id>`.
- Every item route passes two checks: the action against the collection's SRN, then against the item's, `srn:<project>:collection_item:<key>`, with the item's tags as `soat:ResourceTag/<key>`. A listing compiles the second check into the query, so it returns only the items the caller may read.
- A write is judged against the tags the item holds and the tags it will hold, so a principal scoped by tag cannot move an item into or out of its scope.
- A read the caller may not make answers `404`.

To confine a principal to one actor's items, grant the collection and condition the items:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["collections:*"],
      "resource": ["srn:proj_V1StGXR8Z5jdHi6B:collection:*"]
    },
    {
      "effect": "Allow",
      "action": ["collections:*"],
      "resource": ["srn:proj_V1StGXR8Z5jdHi6B:collection_item:*"],
      "condition": { "StringEquals": { "soat:ResourceTag/actor_id": "actor_V1StGXR8Z5jdHi6B" } }
    }
  ]
}
```

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `COLLECTION_QUERY_TIMEOUT_MS` | No | Statement timeout of an item listing, in milliseconds (default `5000`) |

## Examples

### Create a collection

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-collection --project-id proj_V1StGXR8Z5jdHi6B --name support-tickets
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await soat.collections.createCollection({
  body: { project_id: 'proj_V1StGXR8Z5jdHi6B', name: 'support-tickets' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST "$SOAT_BASE_URL/api/v1/collections" \
  -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_V1StGXR8Z5jdHi6B","name":"support-tickets"}'
```

</TabItem>
</Tabs>

### Write an item

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat put-collection-item \
  --collection-id coll_V1StGXR8Z5jdHi6B \
  --key ticket-1042 \
  --data '{"status":"open","priority":2}' \
  --tags '{"actor_id":"actor_V1StGXR8Z5jdHi6B"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await soat.collections.putCollectionItem({
  path: { collection_id: 'coll_V1StGXR8Z5jdHi6B', key: 'ticket-1042' },
  body: {
    data: { status: 'open', priority: 2 },
    tags: { actor_id: 'actor_V1StGXR8Z5jdHi6B' },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PUT "$SOAT_BASE_URL/api/v1/collections/coll_V1StGXR8Z5jdHi6B/items/ticket-1042" \
  -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":{"status":"open","priority":2},"tags":{"actor_id":"actor_V1StGXR8Z5jdHi6B"}}'
```

</TabItem>
</Tabs>

### Filter items

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-collection-items \
  --collection-id coll_V1StGXR8Z5jdHi6B \
  --data '{"status":"open","priority":{"gte":2}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data } = await soat.collections.listCollectionItems({
  path: { collection_id: 'coll_V1StGXR8Z5jdHi6B' },
  query: { data: JSON.stringify({ status: 'open', priority: { gte: 2 } }) },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -G "$SOAT_BASE_URL/api/v1/collections/coll_V1StGXR8Z5jdHi6B/items" \
  --data-urlencode 'data={"status":"open","priority":{"gte":2}}' \
  -H "Authorization: Bearer $SOAT_TOKEN"
```

</TabItem>
</Tabs>
