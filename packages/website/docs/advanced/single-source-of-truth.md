---
description: 'One project as the record many orchestrations, triggers and agents write and read, with no store beside it: what that needs, and where each part lives.'
keywords:
  - single source of truth
  - document versioning
  - conditional writes
  - metadata schema
  - structured filters
  - durable triggers
  - NDJSON export
---

# Single Source of Truth

One SOAT project can be the record for a system where many orchestrations, triggers and agents write reports as [documents](../modules/documents.md) and facts as [memories](../modules/memories.md), and read each other's, with no external store beside it.

This page maps what such a record needs to the module that provides it. The module pages hold the definitions; nothing is re-defined here. [Single Source of Truth](../tutorials/single-source-of-truth.md) walks the write half against one project.

## What the record needs

| Need                                   | Mechanism                                                                  | Where                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| One address per record                 | `project_id` + `path` is unique on documents                               | [Documents](../modules/documents.md#path-field)                                                        |
| One fact stored once                   | Dedup and supersession on write; a declared `supersedes`                   | [Memories](../modules/memories.md#write-algorithm)                                                     |
| Access control on every read and write | IAM policies, tag conditions, `boundary_policy`                            | [IAM](../modules/iam.md), [Agents](../modules/agents.md)                                               |
| A write that cannot be lost            | `version` counter, `expected_version` / `If-Match`, `409 VERSION_CONFLICT` | [Concurrent Writes](./concurrent-writes.md)                                                            |
| Every past state readable              | Append-only document versions; restore appends                             | [Documents](../modules/documents.md#versioning)                                                        |
| Withdraw without losing history        | Tombstone version; `?include_withdrawn=true`                               | [Documents](../modules/documents.md#withdrawal)                                                        |
| Retire a fact that stopped holding     | `invalidated_at`; `retracted` assertion                                    | [Memories](../modules/memories.md#retraction)                                                          |
| Who claimed what, through which door   | Memory assertion ledger, `source_type`                                     | [Memories](../modules/memories.md#assertions)                                                          |
| Typed fields, not labels               | `metadata` beside `tags`, one line between them                            | [IAM](../modules/iam.md#tags-and-metadata)                                                             |
| One shape every writer is held to      | Metadata schema per path prefix, `400 VALIDATION_FAILED`                   | [Metadata Schemas](../modules/metadata-schemas.md)                                                     |
| Query the record by its fields         | Equality, `in`, ordering on `?metadata=` and in knowledge search           | [Documents](../modules/documents.md#metadata-filters)                                                  |
| Say what a document is to another      | `derived_from`, `supersedes`, `cites`; `?related_to=`                      | [Documents](../modules/documents.md#relations)                                                         |
| Retrieval with citations               | Hybrid search over documents and memories, `source_type` on every hit      | [Knowledge](../modules/knowledge.md)                                                                   |
| Every change reaches its subscribers   | Durable event triggers, webhooks                                           | [Triggers](../modules/triggers.md#delivery-guarantees), [Webhooks](../modules/webhooks.md)             |
| An operational ledger nothing rewrites | Audit log, activity, usage                                                 | [Audit Log](../modules/audit-log.md), [Activity](../modules/activity.md), [Usage](../modules/usage.md) |
| The corpus as a file                   | NDJSON export, oldest first                                                | [Export](#export)                                                                                      |

## Writes

Every document and memory carries a `version`. A write may state the version it read; a write against any other version is refused whole, and two writes that race on one record are serialized whether or not either stated one. [Concurrent Writes](./concurrent-writes.md) is the definition.

A document write that changes content, `title`, `path`, `metadata`, `tags` or chunk configuration archives the state it replaced, so a run can cite the version it read and a later reader can fetch exactly that. Restore appends a new version rather than rewinding, and runs through the ordinary update path, so the restored content is re-chunked and re-embedded.

A memory write is recorded twice: the memory is state, and each write attempt is an [assertion](../modules/memories.md#assertions) naming the principal, the mechanism and the outcome, including the writes that changed nothing.

## Removal

Neither a document nor a memory needs to be deleted to leave the record.

|                    | Document                                                                                 | Memory                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Operation          | [`POST /api/v1/documents/{document_id}/withdraw`](/docs/api/documents/withdraw-document) | [`POST /api/v1/memories/{memory_id}/retract`](/docs/api/memories/retract-memory)   |
| Stored as          | A tombstone version                                                                      | `invalidated_at` with `superseded_by_memory_id` null, plus a `retracted` assertion |
| Leaves             | Listings and knowledge search; chunks drop from the index                                | Listings, dedup and knowledge search                                               |
| Still readable     | By id, with every version                                                                | By id, with its assertions                                                         |
| Comes back through | Restoring a content version                                                              | A new write; dedup never matches a retired fact                                    |
| Event              | `documents.withdrawn`, `documents.restored`                                              | `memories.retracted`                                                               |

`DELETE` stays permanent on both.

## Structure

A record carries two annotation bags. `tags` are flat string labels the platform reads for authorization and scoping. `metadata` is typed JSON the platform stores, validates and filters, and never reads for itself. The line between them is defined once, in [Tags and metadata](../modules/iam.md#tags-and-metadata).

A [metadata schema](../modules/metadata-schemas.md) declares what documents under a path prefix must carry, and every write path that stores the bag is judged by it: the REST routes, a formation, a restore. Documents already stored are not re-judged until their `path` or `metadata` is next written.

The same `metadata` object filters [`GET /api/v1/documents`](/docs/api/documents/list-documents) and [`POST /api/v1/knowledge/search`](/docs/api/knowledge/search-knowledge), with equality, `in` and `gt` / `gte` / `lt` / `lte`, matched by type: `{"revision": 3}` and `{"revision": "3"}` are different filters. A filter narrows what the caller's policy already allows.

A [relation](../modules/documents.md#relations) is a typed edge one document asserts about another. Asserting it is a write of the asserting document alone, and `?related_to=` finds neighbours on either side.

## Delivery

An [event trigger](../modules/triggers.md#event-triggers) writes its firing before the target is touched, so a process that dies mid-dispatch leaves a row another process redelivers. Delivery is at-least-once and deduplicated per `(event, trigger)`, so an event target must be idempotent. [Webhooks](../modules/webhooks.md) deliver the same events outside the platform. The names are listed in [Webhook Events](../webhook-events.md).

## Export

Each export streams newline-delimited JSON, oldest first, one object per line, in the shape the module's listing returns for the same caller. Each is its own IAM action, separate from the listing.

| Export                                                                                          | Narrowed by                                                 | Action                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| [`GET /api/v1/documents/export`](/docs/api/documents/export-documents)                          | `path_prefix`; withdrawn documents and `/.system/` left out | `documents:ExportDocuments` |
| [`GET /api/v1/memory-stores/{memory_store_id}/export`](/docs/api/memory-stores/export-memories) | `?tags=`; `include_invalidated=true` adds retired facts     | `memories:ExportMemories`   |
| [`GET /api/v1/activity/export`](/docs/api/activity/export-activity)                             | The listing's filters                                       | `activity:ExportActivity`   |
| [`GET /api/v1/audit-log/export`](/docs/api/audit-log/export-audit-entries)                      | The listing's filters                                       | `audit:ExportAuditEntries`  |

## Scope

A write precondition covers one record. There is no transaction across records: two writes to two documents are two writes, and where several must move as one, the step is an idempotent [orchestration](../modules/orchestrations.md), as [Concurrent Writes](./concurrent-writes.md#scope) states.
