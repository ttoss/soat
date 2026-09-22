---
description: 'Memory stores and the memories they hold: the facts an agent learns, retrieves and writes back.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Memories

A **memory** is one fact an agent knows. A **memory store** is the named container that holds many of them.

## Overview

A memory store is a namespace for text content that agents read and write during generation. Each store holds many **memories**, embedded for semantic search via the [Knowledge](./knowledge.md) module.

Agents retrieve relevant memories via `knowledge_config` and write new facts with the built-in `write_memory` tool; a store also decides for itself what completed turns may contribute to it, through its [memory rules](#memory-rules). See [Agent Integration](#agent-integration) and the [Memory & Knowledge Engine](../advanced/memory-and-knowledge-engine.md) deep dive. In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md), the write funnel, embedding, the [assertion ledger](#assertions) and invalidation are the **engine**; the [write algorithm](#write-algorithm) and a rule's [handler](#handlers) are the **algorithms**, with customization seams in the [deep dive](../advanced/memory-and-knowledge-engine.md#extending-the-engine-today).

A memory is **state**. Every write that produced or changed it is an **assertion**: some principal, through some mechanism, claimed a fact. The two are separate records, which is what lets a write that changed nothing still leave a trace.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent with Persistent Memory - Step 4 (Create a memory store)](/docs/tutorials/memories-agent#step-4--create-a-memory-store)
- [Agent with Persistent Memory - Step 5 (Write memories)](/docs/tutorials/memories-agent#step-5--write-memories)
- [Agent with Persistent Memory - Step 10 (Observe the agent writing to memory)](/docs/tutorials/memories-agent#step-10--observe-the-agent-writing-to-memory)
- [Agent with Persistent Memory - Step 11 (Add a memory rule)](/docs/tutorials/memories-agent#step-11--add-a-memory-rule)
- [Agent with Persistent Memory - Step 13 (Trace a fact back to the conversation it came from)](/docs/tutorials/memories-agent#step-13--trace-a-fact-back-to-the-conversation-it-came-from)

## Data Model

### Memory Store

| Field         | Type              | Description                               |
| ------------- | ----------------- | ----------------------------------------- |
| `id`          | `string`          | Public ID (`mstore_` prefix)              |
| `project_id`  | `string`          | ID of the owning project                  |
| `name`        | `string`          | Human-readable name                       |
| `description` | `string \| null`  | Optional description                      |
| `tags`        | `object \| null`  | Optional key-value labels for filtering by category |
| `duplicate_threshold` | `number \| null` | The store's skip cutoff; `null` uses the algorithm constant — see [Where the thresholds come from](#where-the-thresholds-come-from) |
| `supersede_threshold` | `number \| null` | The store's supersede cutoff; `null` uses the algorithm constant |
| `created_at`  | `string`          | ISO 8601 creation timestamp               |
| `updated_at`  | `string`          | ISO 8601 last-updated timestamp           |

### Memory

When a memory is created or updated, its `content` is embedded for semantic similarity search. The text and its vector are stored **once per distinct text per store** and shared: a memory holds no copy of its own, and restating text the store already has costs no embedding call at all.

| Field        | Type     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `id`         | `string` | Public ID (`mem_` prefix)                               |
| `memory_store_id` | `string` | ID of the parent memory store                      |
| `content`    | `string` | Text content of the memory                              |
| `source_type` | `string` | Whether there is a source to point at: `manual` (default) or `conversation` — see [Provenance](#provenance) |
| `source_id`  | `string \| null` | The [conversation](./conversations.md) this fact was learned in when `source_type` is `conversation`; `null` when `manual` |
| `tags`       | `object \| null`   | Per-memory key-value labels for memory-granularity tag filtering in [Knowledge search](./knowledge.md) |
| `metadata`   | `object \| null`   | Caller-owned annotations on the memory — see [Tags and metadata](iam.md#tags-and-metadata)    |
| `invalidated_at` | `string \| null` | When the memory stopped holding, superseded or retracted; `null` means currently valid — see [Temporal invalidation](#temporal-invalidation) |
| `superseded_by_memory_id` | `string \| null` | The memory that replaced this one, when superseded; `null` when a retraction withdrew it |
| `version`    | `integer` | Write version, starting at 1 and incremented on every update — see [Concurrent writes](#concurrent-writes) |
| `created_at` | `string` | ISO 8601 creation timestamp                             |
| `updated_at` | `string` | ISO 8601 last-updated timestamp                         |

### Memory Assertion

One row per write attempt, append-only, whatever the write resolved to.

| Field        | Type     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `id`         | `string` | Public ID (`massert_` prefix)                           |
| `memory_store_id` | `string` | ID of the store written to                         |
| `memory_id`  | `string \| null` | The memory the write resolved into: the new memory for `created` and `superseded`, the memory that matched for `skipped`, the memory withdrawn for `retracted` |
| `superseded_memory_id` | `string \| null` | The memory this assertion retired, on a `superseded` outcome |
| `content`    | `string` | The text **as asserted**, which is not always the memory's text — a `skipped` assertion records what was claimed |
| `mechanism`  | `string` | Which door the write came through: `tool`, `rule`, `api` or `formation` — see [Mechanism](#mechanism) |
| `rule_id`    | `string \| null` | The [memory rule](#memory-rules) whose firing wrote this (`mrule_` prefix); set only for `rule`. `null` once that rule is deleted |
| `generation_id` | `string \| null` | The turn that asserted the fact; `null` on the `api` and `formation` doors |
| `principal_type` | `string` | Who claimed it, in the vocabulary a [generation](./generations.md) records its starter with, plus `agent` |
| `principal_id` | `string` | The principal's public ID                             |
| `outcome`    | `string` | `created`, `superseded`, `skipped` or `retracted`        |
| `similarity` | `number \| null` | The cosine the outcome was decided against — the top match's, or the declared target's when `declared` is true; `null` when there was nothing to compare against, and on a retraction, which compares nothing |
| `declared`   | `boolean` | Whether the caller named the memory this write replaced (`supersedes`) instead of the thresholds choosing one |
| `created_at` | `string` | ISO 8601 creation timestamp                             |

## Key Concepts

### What belongs in a memory

A memory is a **fact the agent learns about the world** (a customer's shipping
address, a decision a team reached, a constraint discovered while working), retrieved by
semantic similarity and consumed as context.

Retrieval is **approximate**: the shared content row's vector carries an HNSW index, so a
similarity search reads a bounded candidate list rather than scanning every memory. Recall
against the exact top-k is below 1.0, and `min_similarity` thresholds tuned against an
exact scan may select a slightly different set. See
[Ranking is approximate](./knowledge.md#ranking-is-approximate); it applies to memory
search and to the dedup similarity check below alike.

A **correction to the agent's behavior** ("never quote a delivery date without checking
stock") is doctrine, not a fact, and its application must not depend on retrieval rank.
It has two homes:

- **A constraint that must never be violated** — a [guardrail](./guardrails.md) `deny`,
  which refuses the action deterministically.
- **Guidance the model should follow** — the agent's `instructions`, which
  [agent versions](./agents.md#versioning-and-staged-rollout) archive on every write.

When the same correction keeps being made by hand, the
[approvals recurrence view](./approvals.md#recurrence-view) surfaces it.

### Write Algorithm

Every write to a memory store — REST, the agent tool, a post-turn rule, a formation — goes through the same three-outcome algorithm. There is **no model call** anywhere in it.

1. **Resolve the content.** The text is matched against what the store already holds, by a hash of its trimmed, whitespace-collapsed form. A hit reuses the stored row and its vector and reaches no embedder; a miss embeds once and stores the pair.
2. **Find the top match** — the most similar **currently-valid** memory in that store, by cosine. [Invalidated memories](#temporal-invalidation) are never candidates.
3. **Resolve to one outcome:**

| Similarity range        | Outcome        | What happens                                                                                  |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| ≥ `duplicate_threshold` | **skipped**    | The fact is already known. The existing memory is returned unchanged.                           |
| ≥ `supersede_threshold` | **superseded** | The same fact, changed. The match is invalidated and points at a new memory holding the new text. |
| below it                | **created**    | A distinct fact. A new memory is written.                                                       |

Every call records exactly one [assertion](#assertions), whatever the outcome.

On a **supersede**, the retired memory's `tags` and `metadata` are shallow-merged onto the replacement (incoming keys win), so a replacement stays inside every tag-scoped search and policy the original satisfied. [`PUT /api/v1/memories/:id`](/docs/api/memories/update-memory) replaces `tags`/`metadata` outright; pass `null` (or `{}` for tags) to clear.

Below `supersede_threshold`, cosine covers both "same fact, changed" and "related but distinct" (*prefers email* vs *prefers Portuguese*), and embeddings sit close on negations. `created` is the outcome there because a near-duplicate stays searchable while a wrongly retired fact does not.

#### Declaring the supersede

The bands retire a contradiction only when the two texts are near-identical. *The office is in Lisbon* and *We closed the Lisbon office* contradict each other and score nowhere near `supersede_threshold`, so both would stay live and searchable. Lowering the threshold to catch that would start retiring merely-related facts.

`supersedes` on [`POST /api/v1/memories`](/docs/api/memories/create-memory) names the memory a write replaces. The declaration **outranks the bands in both directions**: the named memory is retired and the outcome is `superseded` whether the two texts score above `duplicate_threshold` or far below `supersede_threshold`. A declaration is not a similarity question, so the top-match search is not run at all — nothing else in the store is touched.

| The declaration | Result |
| --- | --- |
| A still-valid memory in the same store, and the caller may update it | `200`, `superseded` — the target is retired and the response is the replacement |
| A memory in another store | `400 VALIDATION_FAILED` |
| A memory already superseded | `400 VALIDATION_FAILED` — no chaining; supersede the replacement instead |
| No memory with that id | `404 RESOURCE_NOT_FOUND` |

Authorization is the write grant **plus** the target's: `memories:CreateMemory` on the store, and `memories:UpdateMemory` on the memory named — evaluated through the same two tag bags [`PUT /api/v1/memories/{memory_id}`](/docs/api/memories/update-memory) uses, so `soat:ResourceTag` conditions apply to the target as on any update. A declaration therefore says no more, and does no more, than updating that memory directly would.

The replacement inherits the retired memory's `tags` and `metadata` exactly as a threshold supersede does, and the [assertion](#assertions) records `declared: true` with the cosine to the target — which decides nothing here, and is the number that says how far apart the two statements were.

### Where the thresholds come from

Three layers, resolved request → store → constant, each value independently; the first non-null wins.

| Layer | Where | Scope |
| --- | --- | --- |
| Per-request | `duplicate_threshold` / `supersede_threshold` on [`POST /api/v1/memories`](/docs/api/memories/create-memory) | that one call |
| Store default | `duplicate_threshold` / `supersede_threshold` on the memory store, settable on create, update and as a formation resource property | the corpus's dedup policy |
| Algorithm constant | built in | `0.95` / `0.90` |

Only the `api` door takes per-request values. The [`write_memory` tool](#write_memory-tool) and a [memory rule](#memory-rules) always use the store's effective pair: a writer that could loosen the corpus's dedup policy from the side would make the store-level default meaningless. A formation sets store defaults through the store resource, never per memory.

**Invariant:** the *effective* pair must satisfy `supersede_threshold < duplicate_threshold`. Equal makes `superseded` unreachable; inverted swallows `skipped`. Both are rejected with `400 VALIDATION_FAILED`, on the store write and on the request — and on the request the check runs against the effective pair, so a body overriding only one value cannot invert it against the store's other one. Each value is bounded to `[0, 1]`.

#### Response `action` Field

The response always includes an `action` field alongside the memory:

| `action`     | HTTP status | Meaning                                                                 |
| ------------ | ----------- | ----------------------------------------------------------------------- |
| `created`    | `201`       | New memory written                                                       |
| `superseded` | `200`       | The match was invalidated and replaced; the **replacement** is returned   |
| `skipped`    | `200`       | The fact was already known; the existing memory is returned unchanged     |

### Assertions

A memory row is **state**. The write that produced it is an **event**, recorded separately: one `memory_assertion` per write attempt, appended whatever the outcome, including the writes that changed nothing.

An assertion names the content as asserted (not always the memory's text), the outcome and the similarity that chose it, whether the supersede was `declared` by the caller rather than chosen by the thresholds, the principal who claimed the fact, the mechanism it came through, and — for anything an agent wrote — the generation it happened in.

#### Mechanism

`mechanism` answers *through which door*, never *who*:

| `mechanism` | The write |
| --- | --- |
| `tool` | the agent's [`write_memory`](#write_memory-tool) call, mid-turn |
| `rule` | a [memory rule](#memory-rules) firing on a finished turn, named by `rule_id` |
| `api` | [`POST /api/v1/memories`](/docs/api/memories/create-memory) |
| `formation` | a `memory` resource in an applied [formation](./formations.md) |

The *who* is `principal_type` / `principal_id`. On both agent doors the principal is the **agent whose turn it was**: a rule decides what the corpus accepts, but the agent is who said the thing. The generation's own `started_by` names whoever asked for the turn, which is a different question again.

#### Reading the ledger

- [`GET /api/v1/memories/{memory_id}/assertions`](/docs/api/memories/list-memory-assertions) — one memory's full history, oldest first, skips included. A `superseded` assertion also names the memory it retired, so the chain reads in both directions. A retired memory keeps its own assertions.
- [`GET /api/v1/memory-stores/{memory_store_id}/assertions`](/docs/api/memory-stores/list-memory-store-assertions) — the store's ledger, newest first, filterable by `mechanism`, `outcome`, `generation_id` and `since`. This is the volume question as a query.
- [`GET /api/v1/generations/{generation_id}`](/docs/api/generations/get-generation) carries `memory_assertions` alongside the per-rule [`extraction` counts](#what-a-firing-records), so the summary and the rows it summarizes reconcile — and it covers the `write_memory` calls the summary never saw.

Both listings are gated on `memories:ListMemoryAssertions`, against the store's SRN like every other item read.

Validity — `invalidated_at` and `superseded_by_memory_id` — is on the memory, not on the assertion: it is the filter on every read, and one memory has one answer however many writes reached it. `superseded_memory_id` is read back from the memory, and is unique because a write supersedes exactly its top match; a `retracted` assertion leaves it null, because the memory it retired is the one `memory_id` already names.

### Provenance

`source_type` answers one question: **is there a source to point at?**

| `source_type`  | `source_id`                        | Written by |
| -------------- | ---------------------------------- | ---------- |
| `conversation` | the conversation's public ID       | a [memory rule](#memory-rules) firing on a conversation turn |
| `manual`       | `null`                             | [`POST /api/v1/memories`](/docs/api/memories/create-memory), the [`write_memory` tool](#write_memory-tool), and a rule firing on a bare agent generation |

It deliberately does **not** describe the write *mechanism*. A fact the `write_memory`
tool wrote during a generation that belongs to no conversation reads `manual`, because
there is nothing to name — not because a human typed it.

Provenance is recorded when the memory is created and never rewritten. A turn that replaces
the fact supersedes it with a new memory carrying its own provenance. Which door a write came
through, and which turn made it, are on the [assertion](#assertions) instead.

`source_id` is a loose pointer, not a foreign key: deleting the conversation leaves the id
in place. The fact *was* learned there, and the record of where it came from outlives its
source.

See [Agent with Persistent Memory - Step 13 (Trace a fact back to the conversation it came from)](/docs/tutorials/memories-agent#step-13--trace-a-fact-back-to-the-conversation-it-came-from).

### Temporal invalidation

A memory that no longer holds is **retired rather than rewritten**: superseding sets
`invalidated_at` and points `superseded_by_memory_id` at the replacement, and
[retracting](#retraction) sets `invalidated_at` with nothing to point at.

Invalidated memories are excluded from:

- memory listing ([`GET /api/v1/memories`](/docs/api/memories/list-memories)) unless `include_invalidated=true` is passed
- [write deduplication](#write-algorithm) — a retired fact is never a match candidate, so
  restating superseded knowledge creates a new memory
- [Knowledge search](./knowledge.md), so a retired fact is never injected into a generation

They stay readable by ID ([`GET /api/v1/memories/{memory_id}`](/docs/api/memories/get-memory)),
with their original text and their own [assertions](#assertions), for audit.

A supersede and a retraction are the two ways a memory reaches that state — the first
because the fact changed, whether the thresholds chose the memory or the caller
[declared it](#declaring-the-supersede), the second because it stopped holding with nothing
taking its place. `DELETE` remains the way to remove a memory outright.

### Retraction

[`POST /api/v1/memories/{memory_id}/retract`](/docs/api/memories/retract-memory) withdraws a
fact. The memory leaves every default read at once, because a retraction is an invalidation
and validity is already the filter each of them applies — there is no second exclusion to
keep in sync.

What tells a retraction from a supersede is what it leaves behind: `superseded_by_memory_id`
stays `null`, and the [ledger](#assertions) gets an assertion with outcome `retracted`
naming who withdrew the fact. Restating the fact later lands as a new memory, since dedup
only ever matches a valid one.

The write claims the memory's `version`, so it takes `expected_version` or `If-Match` like
[any other write](#concurrent-writes). A memory that is already invalidated — retracted, or
superseded by a later write — answers `409 MEMORY_ALREADY_INVALIDATED`.

### Concurrent writes

[`PUT /api/v1/memories/{memory_id}`](/docs/api/memories/update-memory) may name the version it is
changing, either `expected_version` in the body or an `If-Match` header, and is refused with
`409 VERSION_CONFLICT` when the memory has moved on since — see [Concurrent Writes](../advanced/concurrent-writes.md).
A caller that states nothing still gets the version bump: two writers racing on the same memory
serialize, and the loser sees the conflict rather than silently overwriting the winner. A
[retraction](#retraction) claims the same counter, so it is refused the same way.

### NDJSON export

[`GET /api/v1/memory-stores/{memory_store_id}/export`](/docs/api/memory-stores/export-memories) streams one store's memories as newline-delimited JSON, oldest first, one memory object per line.

- Invalidated memories — retracted or superseded — are left out unless `include_invalidated=true`, so the file holds what the store currently asserts.
- `?tags=` narrows it exactly as it narrows the listing, and a policy condition on a memory's own tags applies the same way.
- The response streams and pages internally.
- Authorized by `memories:ExportMemories`, separate from `memories:ListMemories`.

### Tag Filtering

Tags are free-form strings attached to a memory store at creation or update time.

```json
POST /api/v1/memory-stores
{
  "project_id": "proj_abc",
  "name": "Customer Preferences",
  "tags": { "domain": "customer", "system": "crm" }
}
```

Tags are key-value pairs, the same shape documents, actors, files, conversations and sessions carry, and the shape the IAM `soat:ResourceTag/<key>` condition reads.

The `tags` query parameter on [`GET /api/v1/memory-stores`](/docs/api/memory-stores/list-memory-stores) filters by pair, written `key:value` in the query string:

```bash
# every pair must match, exactly and case-sensitively
GET /api/v1/memory-stores?tags=domain:customer&tags=system:crm
```

The split is on the **first** colon, so a value may contain colons of its own (`url:https://example.com`). Repeat the parameter for several pairs; **all** must be present. A value with no colon is rejected rather than guessed at.

The tag map is also its own sub-resource — [`GET /api/v1/memory-stores/:id/tags`](/docs/api/memory-stores/get-memory-store-tags), [`PUT /api/v1/memory-stores/:id/tags`](/docs/api/memory-stores/replace-memory-store-tags) (replace) and [`PATCH /api/v1/memory-stores/:id/tags`](/docs/api/memory-stores/merge-memory-store-tags) (merge) — the same three routes every tagged resource exposes. All three return the tag map, not the store. See [IAM — Tags](./iam.md#tags).

### Tag Conditions

A policy condition on `soat:ResourceTag/<key>` reads these tags, so access can be granted by attribute rather than by id. Both bags take part, at the level that owns them:

| Surface | What the condition reads |
|---|---|
| [`GET /api/v1/memory-stores`](/docs/api/memory-stores/list-memory-stores), and every single-store route | the store's own tags |
| [`GET /api/v1/memories`](/docs/api/memories/list-memories) | the owning store's tags to reach the listing at all, then each memory's own tags to narrow it |
| A single memory, and the memory tag sub-routes | the memory's own tags **and** its store's — both must permit |
| [Knowledge search](./knowledge.md) | the same pair, compiled into the query: a memory is returned only when its store and itself are both permitted |

A memory is therefore never more visible than the store holding it: a condition that hides a store hides its memories, whatever they carry. A resource with no tag at all satisfies `StringNotEquals` — an absent key is not the excluded value — so untagged stores and memories stay visible under a `StringNotEquals` rule.

Walk it end to end in [Tag-Based Access Control](../tutorials/tag-based-access-control.md).

### Memory-Level Tag Filtering

Memories carry their own `tags` (and optional `metadata`), independent of the store's tags. [`GET /api/v1/memories`](/docs/api/memories/list-memories) filters them with the same `?tags=key:value` parameter, and [`GET /api/v1/memories/:id/tags`](/docs/api/memories/get-memory-tags), [`PUT /api/v1/memories/:id/tags`](/docs/api/memories/replace-memory-tags) and [`PATCH /api/v1/memories/:id/tags`](/docs/api/memories/merge-memory-tags) manage the bag without touching `content`. `tags` in [Knowledge search](./knowledge.md) and an agent's `knowledge_config.tags` match at **memory granularity**: a memory is returned when its parent store's tags contain the pairs (store-level, all its memories returned) **or** its own tags do (only that memory returned). A single store can thus hold memories for many roles/sources: tag captured rules with `role: traffic-manager` and `source: rejected_approval`, then search `tags: { "role": "traffic-manager" }` to read only those.

```bash
soat create-memory \
  --memory-store-id mstore_01 \
  --content "Reject refunds above $500 for the traffic-manager role" \
  --tags '{"role": "traffic-manager", "source": "rejected_approval"}' \
  --metadata '{"evidence": "high"}'
```

### Agent Integration

#### Automatic Knowledge Retrieval

Set `knowledge_config` on an agent to have the server search relevant memories before every generation and inject them as a delimited reference-context message (never as `system` content, since memories can be user-derived). See [Knowledge Config](./agents.md#knowledge-config).

#### `write_memory` Tool

Set `write_memory_store_id` in the agent's `knowledge_config` to inject a `write_memory` tool into every generation. The tool accepts a single `content` input, the atomic fact to write. The target store is fixed by `write_memory_store_id`; the agent cannot choose another, and it cannot set thresholds — the store's effective pair applies.

The agent's [`boundary_policy`](./agents.md#soat-action-permissions) gates the tool: it must allow `memories:CreateMemory` **and** `memories:UpdateMemory` (a write may supersede) on the target store's SRN, `srn:<project_id>:memory_store:<memory_store_id>`, with the store's tags as condition inputs. A boundary scoped to one store therefore holds even if `write_memory_store_id` is later pointed elsewhere.

Memories written by the tool carry `source_type: "manual"`: `source_id` is a pointer a client supplies on a hand-written fact, and the tool has none to give. The turn behind the write is on its [assertion](#assertions), with `mechanism: "tool"` and the agent as principal.

```json
{
  "knowledge_config": {
    "memory_store_ids": ["mstore_alice"],
    "write_memory_store_id": "mstore_alice"
  }
}
```

### Memory Rules

A **memory rule** is a store's **ingestion policy**: what a completed agent turn is allowed to contribute to *this* corpus, and who decides. It lives on the destination, because the question it answers — "what feeds this store?" — is a property of the store, not of any one agent.

That makes it the opposite half of the [`write_memory` tool](#write_memory-tool), which is a *capability grant* on an agent and stays where it is:

| | `write_memory` tool | memory rule |
| --- | --- | --- |
| **Who decides** | the agent, mid-turn, at its discretion | the platform, after every completed turn |
| **What it is** | a capability grant — this agent may write there | an ingestion policy — this is what the corpus accepts |
| **Reads** | the agent's whole context | exactly one turn's transcript |
| **Lives on** | the agent | the memory store |

Because a rule belongs to its store, one store can have several (a cheap general one, a strict one for billing turns), one agent can feed two stores under different rules, and "what feeds this store?" is one listing instead of a sweep over every agent in the project.

#### The rule

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Public ID (`mrule_` prefix) |
| `memory_store_id` | `string` | The destination store, and the rule's owning scope. Deleting the store deletes its rules |
| `project_id` | `string` | The store's project |
| `on` | `string` | The [event](#events) the rule reads |
| `source_agent_ids` | `array \| null` | Agents whose turns it reads; `null` is every agent in the project |
| `agent_id` | `string \| null` | Handler agent — mutually exclusive with `tool_id` |
| `tool_id` | `string \| null` | Handler tool — mutually exclusive with `agent_id` |
| `action` | `string \| null` | Operation id, for a tool handler |
| `preset_parameters` | `object \| null` | Merged into a tool handler's input; the turn's own fields are reserved and win |
| `prompt` | `string \| null` | Replaces the built-in extractor's task instructions |
| `ai_provider_id` | `string \| null` | Provider override for the built-in extractor |
| `model` | `string \| null` | Model override for the built-in extractor |
| `enabled` | `boolean` | A disabled rule is kept and never fires |
| `created_at` | `string` | ISO 8601 creation timestamp |
| `updated_at` | `string` | ISO 8601 last-updated timestamp |

Manage them with [`POST /api/v1/memory-rules`](/docs/api/memory-rules/create-memory-rule), [`GET /api/v1/memory-rules`](/docs/api/memory-rules/list-memory-rules) (pass `memory_store_id` to read one store's policy), [`GET /api/v1/memory-rules/{memory_rule_id}`](/docs/api/memory-rules/get-memory-rule), [`PATCH /api/v1/memory-rules/{memory_rule_id}`](/docs/api/memory-rules/update-memory-rule) and [`DELETE /api/v1/memory-rules/{memory_rule_id}`](/docs/api/memory-rules/delete-memory-rule). Every one is authorized against the **store's** SRN, with `memories:{Create,Get,List,Update,Delete}MemoryRule`.

#### Events

| `on` | Fires | Fit |
| --- | --- | --- |
| `agents.generation.completed` | once per completed turn — conversation or bare, streaming or not | turn-level extraction, and the **only** event the built-in extractor may bind to |
| `conversations.message.generated` | once per persisted assistant reply | conversation-backed only; fine for a custom handler |

`conversations.message.created` is deliberately not offered: it fires per message, including the user's and before the reply, so a rule bound there would read half a turn.

#### Handlers

A rule's handler decides *what* is worth remembering. It **proposes candidates and never writes**:

```json
{ "facts": [{ "content": "Customer prefers email", "tags": { "kind": "preference" } }] }
```

| Handler | Set | Behaviour |
| --- | --- | --- |
| built-in extractor | neither `agent_id` nor `tool_id` | A tool-less completion over the turn's transcript asking for a JSON array of atomic facts. `prompt`, `ai_provider_id` and `model` tune it |
| agent | `agent_id` | The agent is generated against the transcript and its reply is parsed as the contract above |
| tool | `tool_id` (+ `action`) | The tool is called with `{ event, rule_id, agent_id, generation_id, conversation_id, transcript }` plus `preset_parameters`, and its output is parsed as the contract above |

Because the write algorithm has [no model call in it](#write-algorithm), an agent handler and a tool handler behave identically once they return — a tool handler is not a degraded path.

The server then runs each candidate through the standard [write algorithm](#write-algorithm) on the store's effective thresholds, against the project's `storage_bytes` quota, and appends one [assertion](#assertions). **A handler can propose garbage and cannot corrupt the store.** Anyone who wants to bypass the algorithm still has [`POST /api/v1/memories`](/docs/api/memories/create-memory).

The three fields that configure the built-in extractor cannot be combined with a handler: a handler makes its own model call, or none, so they would be accepted and ignored.

Provider resolution for the built-in extractor: `ai_provider_id` → the source agent's pinned provider → the agent's [`model_route_id`](./model-routes.md) → the project's [`default_model_route_id`](./model-routes.md#project-default-route). Model resolution for the provider cases: the rule's `model` → the override provider's `default_model` (when `ai_provider_id` is set) → the agent's `model` → the agent provider's `default_model`. A provider override falls back to *that* provider's default because the agent's model name is usually meaningless on a different provider. When resolution lands on a route, each target names its own model (so `model` does not apply), the call gets ordered provider failover, and it is metered against the target that served.

The custom `prompt` controls *what* to extract, not the response format; the server always appends the JSON-array contract line and the transcript.

#### What a firing records

- Each write appends an [assertion](#assertions) with `mechanism: "rule"`, the rule's `rule_id`, and the turn's `generation_id`. The principal is the **source agent**.
- Memories from a conversation turn carry `source_type: "conversation"` and its id in `source_id`; a bare agent generation has no conversation, so those read `manual`.
- Rules bound to `agents.generation.completed` record a summary on the originating generation's `extraction` field ([Generations](./generations.md) API), keyed by rule id: `{ "mrule_…": { candidates, created, superseded, skipped } }`. A store can have several rules, so one flat pair of counts could not say which produced them. Firings on `conversations.message.generated` are visible in the assertion ledger, like every other write.
- A rule never blocks or fails the turn it reads: a handler that throws, times out, or answers with nonsense contributes nothing.

#### Loop guard

A handler agent's own generation completes and emits `agents.generation.completed` like any other, so the dispatcher skips two kinds of turn: one it started itself (the generation is stamped `source: "memory_rule"`), and one by an agent that handles any rule in the project — which is what keeps "test the handler by hand" from becoming an infinite mill. A handler generation also declares the source turn as its initiator, so it inherits that turn's trace lineage and continuation budget.

#### Example

Two rules on one store, different handlers, different selectors — unexpressible when extraction lived on the agent:

```json
{
  "resources": {
    "SupportFacts": { "type": "memory_store", "properties": { "name": "Support facts" } },

    "GeneralExtraction": {
      "type": "memory_rule",
      "properties": {
        "memory_store_id": { "ref": "SupportFacts" },
        "on": "agents.generation.completed",
        "source_agent_ids": [{ "ref": "SupportAgent" }],
        "model": "<cheap-model>"
      }
    },

    "BillingExtraction": {
      "type": "memory_rule",
      "properties": {
        "memory_store_id": { "ref": "SupportFacts" },
        "on": "agents.generation.completed",
        "source_agent_ids": [{ "ref": "BillingAgent" }],
        "agent_id": { "ref": "StrictBillingExtractor" }
      }
    }
  }
}
```

See [Agent with Persistent Memory - Step 11 (Add a memory rule)](/docs/tutorials/memories-agent#step-11--add-a-memory-rule).

## Examples

### Create a memory store

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory-store \
  --project-id proj_ABC \
  --name "Customer Preferences" \
  --tags '{"domain": "customer", "system": "crm"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.memoryStores.createMemoryStore({
  body: {
    project_id: 'proj_ABC',
    name: 'Customer Preferences',
    tags: { domain: 'customer', system: 'crm' },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/memory-stores \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "Customer Preferences",
    "tags": { "domain": "customer", "system": "crm" }
  }'
```

</TabItem>
</Tabs>

### Write a memory

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-memory \
  --memory-store-id mstore_01 \
  --content "Customer prefers email over phone calls"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.memories.createMemory({
  body: { memory_store_id: 'mstore_01', content: 'Customer prefers email over phone calls' },
});
if (error) throw new Error(JSON.stringify(error));
// data.action is "created", "superseded", or "skipped"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/memories \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"memory_store_id": "mstore_01", "content": "Customer prefers email over phone calls"}'
```

</TabItem>
</Tabs>
