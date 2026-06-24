# PRD: Memory Module

## Implementation Status

| Component                      | Status         | Notes                                                                                                                            |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Memory model (container CRUD)  | ✅ Implemented | Model, lib, REST, OpenAPI, permissions, tests, docs                                                                              |
| Memory tags field              | ✅ Implemented | `tags` string-array column on Memory model; glob filter on `GET /memories`; `resolveMemoryIdsByGlobTags()` in knowledge search   |
| MemoryEntry model              | ✅ Implemented | Model with `me_` prefix, embedding column, lib, REST, OpenAPI, permissions, tests                                                |
| Entry write (dedup algorithm)  | ✅ Implemented | Two-threshold dedup/merge/skip in `writeMemoryEntry`; `mergeEntryContent` concatenates existing and incoming content             |
| Entry REST endpoints           | ✅ Implemented | `POST/GET/PUT/DELETE /api/v1/memories/:memoryId/entries`; POST returns `action` field                                            |
| Entry permissions              | ✅ Implemented | `WriteMemoryEntry`, `ReadMemoryEntry`, `ListMemoryEntries`, `UpdateMemoryEntry`, `DeleteMemoryEntry`                             |
| `knowledgeConfig` on Agent     | ✅ Implemented | JSONB field on Agent model; merged with per-generation config; drives automatic context injection                                |
| Extraction (post-conversation) | ✅ Implemented | `runMemoryExtraction()` in `memoryExtraction.ts`; opt-in via `knowledge_config.extraction: true` + `write_memory_id`; summary on generation `metadata.extraction` |
| Knowledge integration          | ✅ Implemented | `resolveMemorySearch()` in `knowledgeMemory.ts`; `memoryIds`/`memoryTags` in `searchKnowledge()`                                 |
| MemoryEntity model             | ❌ Not started | Project-scoped extracted nouns/objects with `mey_` prefix, embedding column, optional `actorId` FK; deduplicated across memories |
| MemoryEntryEntity join table   | ❌ Not started | Links entries to entities with relationship label and direction                                                                  |
| Entity extraction on write     | ❌ Not started | Synchronous best-effort extraction inside `writeMemoryEntry()`; LLM extracts subject/relationship/object triples                 |
| Entity-based knowledge queries | ❌ Not started | Memory-side `resolveEntitySearch()` (entity/actor → entry-set joins). Query surface specced in prd-knowledge.md Phase 3          |

## Implementation Phases

### Phase 1 — Memory Storage & Write Algorithm ✅ Complete

**Goal:** Give developers a REST API to create memories, write entries with automatic deduplication, and manage the full entry lifecycle.

**Deliverables:**

- `Memory` and `MemoryEntry` DB models with pgvector embedding column
- `writeMemoryEntry()` lib function with two-threshold dedup/merge/skip algorithm
- `mergeEntryContent()` concatenating existing and incoming content
- `POST/GET/PUT/DELETE /api/v1/memories` — memory CRUD
- `POST/GET/PUT/DELETE /api/v1/memories/:memoryId/entries` — entry CRUD; POST returns `action` field
- OpenAPI spec, permissions (`WriteMemoryEntry`, `ReadMemoryEntry`, etc.), tests

**Unlocks:** Manual memory management via REST. Developers can build their own write workflows.

---

### Phase 2 — Agent Read & Write ✅ Complete

**Goal:** Make agents memory-aware. Agents can recall facts before generating and write new facts during generation. This is the minimum needed for a compelling AI app tutorial.

**Deliverables:**

- ✅ **Memory source in `searchKnowledge()`** — `memoryIds` and `memoryTags` parameters added; `resolveMemorySearch()` queries MemoryEntry embeddings; results interleaved by score; `source_type: "memory"` in `KnowledgeResult`
- ✅ **`document_paths` and `document_ids` parameters** — flat fields in OpenAPI spec and lib (replacing nested `document_filters`)
- ✅ **`knowledge_config` on Agent** — JSONB field on `agents` table; merged with per-generation `knowledge_config` using append semantics; drives automatic context injection via `buildKnowledgeMessages()` in `agentKnowledge.ts`
- ✅ **Automatic context injection** — `buildKnowledgeMessages()` called in `agentGeneration.ts` before each generation; results injected as system messages
- ✅ **`write_memory` tool via `write_memory_id`** — setting `knowledge_config.write_memory_id` on an agent auto-injects a `write_memory` tool (takes `{ content }`); the tool resolves the target memory and calls `writeMemoryEntry()` with `source: 'agent'`; same deduplication semantics as manual writes
- ✅ OpenAPI spec updated, SDK/CLI regenerated, tests added

**Unlocks:** Agents that remember and recall. First tutorial: "Build an agent with persistent memory."

---

### Phase 3 — Memory Tags & Filtering ✅ Complete

**Goal:** Enable memory organisation at scale — multiple memories per project, filtered by tag patterns.

**Deliverables:**

- ✅ `tags` column (string array) on the `Memory` model
- ✅ Tag filter on `GET /api/v1/memories` — supports exact match and glob patterns (`*`, `?`); multiple patterns are ORed
- ✅ `memory_tags` glob matching in `searchKnowledge()` — two-step resolution via `resolveMemoryIdsByGlobTags()` using `ILIKE` on `unnest(tags)`, then entry search on matched memory IDs
- ✅ OpenAPI spec updated (`tags` query param with array schema), SDK/CLI regenerated, tests added, module docs updated

**Unlocks:** Multi-memory projects. Agents scoped to tag-matched memories without knowing IDs upfront.

---

### Phase 4 — Automatic Extraction ✅ Complete

**Goal:** Agents learn passively. Facts are extracted from conversations automatically — no explicit `write_memory` call needed.

**Deliverables:**

- ✅ Post-generation extraction pipeline (fire-and-forget, non-blocking) — `fireMemoryExtraction()` in `src/lib/memoryExtraction.ts`, triggered after completed conversation/session generations (`conversationGeneration.ts`) and direct `POST /agents/:id/generate` calls
- ✅ LLM prompt to extract atomic facts from the completed turn — runs as a plain completion against the agent's own provider/model (`memoryExtractionCompletion.ts`), with no tools and no knowledge injection, so extraction cannot trigger agent side effects
- ✅ Each candidate (max 20 per turn) runs through the standard `writeMemoryEntry()` write algorithm with `source: 'extraction'`
- ✅ Extraction trigger: **opt-in** via `knowledge_config.extraction` + `write_memory_id` — the designated write target, reusing the `write_memory` tool's semantics. *(Design deviation: the original plan keyed extraction off `memory_ids`, but those define the read scope and can be plural; the single write target is unambiguous.)*
- ✅ Extraction overrides: `extraction` accepts `true` (defaults) or an object `{ enabled?, ai_provider_id?, model?, prompt? }` — run extraction on a cheaper provider/model and/or with custom task instructions. Provider overrides are validated against the agent's project; the JSON response contract and transcript are always engine-appended.
- ✅ Summary `{ candidates, created, updated, skipped }` recorded on the generation record's `metadata.extraction`
- ✅ Tests covering trigger conditions, candidate extraction, dedup during extraction, malformed LLM output, and completion failure (`tests/unit/tests/rest/memoryExtraction.test.ts`, `tests/unit/tests/lib/memoryExtraction.test.ts`)

**Not triggered for:** streaming generations and `requires_action` (client-tool) turns — the turn must complete in the same request.

**Unlocks:** Zero-effort conversational memory — agents accumulate knowledge just by talking.

---

### Phase 5 — Entity Graph Layer ❌ Not started

**Goal:** Extract structured entities and relationships from memory entries so knowledge can be queried by graph traversal — not just vector similarity. Enables precise queries like "everything about Pedro" or "what does Company X own?" without relying on embedding proximity.

**Motivation:** Vector search excels at semantic similarity ("find things related to billing") but is weak for structural/relational queries. A memory entry "Pedro owns Company X" embeds as a single vector — querying for "Pedro" may not surface it if the embedding space doesn't place it close enough. An entity graph layer decomposes entries into queryable nodes (entities) and edges (relationships), enabling exact lookups and traversals.

| Query type                              | Vector search                                         | Entity graph                          |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| "What do we know about billing?"        | ✅ Good                                               | ⚠️ Requires entity indexing           |
| "What does Pedro own?"                  | ⚠️ Fuzzy — returns anything _similar_ to "Pedro owns" | ✅ Exact — traverse Pedro → owns → \* |
| "All entities connected to Company X"   | ❌ Poor                                               | ✅ Direct graph traversal             |
| "All memories involving actor `act_01`" | ❌ Impossible without metadata                        | ✅ Direct FK lookup                   |

**Deliverables:**

#### 5a — MemoryEntity + MemoryEntryEntity models

- `MemoryEntity` model (`mey_` prefix) — **project-scoped**, deduplicated nouns/objects extracted from entries, with optional `actorId` FK for entities that correspond to known actors
- Entities live at **project level**, not memory level — enabling cross-memory graph traversal ("find everything about Pedro across all memories")
- `MemoryEntryEntity` join table — links entries to entities with a relationship label (verb) and direction (subject/object)
- CRUD endpoints for entities: `GET/PUT/DELETE /api/v1/entities` (project-scoped, not nested under memories)
- Entity deduplication by embedding similarity within a project (same two-threshold pattern as entries)

#### 5b — Synchronous entity extraction on write

- When `writeMemoryEntry()` creates or updates an entry, run a lightweight LLM extraction to decompose content into `[{ subject, relationship, object }]` triples
- Upsert entities by name within the **project** (deduplicate by embedding similarity)
- Create join records linking the entry to its entities
- **Synchronous, best-effort:** extraction runs inline after the entry is persisted. If it fails, the entry still exists — entities are an enrichment, not a critical path
- Entity extraction from a single atomic entry is cheap (~500ms LLM call), unlike Phase 4's conversation-level extraction

#### Entity Deduplication & Resolution

Entities are deduplicated at **project scope** so the same real-world concept is represented once across all memories. Resolution uses a layered strategy:

1. **Actor-anchored identity (hard match):** If the LLM extraction identifies an entity that matches a known actor (by name or `externalId`), set `actorId` on the entity. Any future entity with the same `actorId` is definitionally the same — skip embedding dedup.

2. **Embedding similarity (soft match):** For non-actor entities, embed `"{name} ({entityType})"` and search existing project-level entities using the two-threshold approach:
   - ≥ 0.95 — same entity → reuse existing
   - 0.75–0.95 — likely same → reuse and enrich properties
   - < 0.75 — different entity → create new

3. **Type-aware disambiguation:** Including `entityType` in the embedding input prevents false merges between same-named entities of different types (e.g., "Pedro" the person vs "Pedro" the project).

**Example — cross-memory resolution:**

```
Memory A entry: "Pedro owns Company X"
  → extracts entity "Pedro" (person) → creates project entity mey_pedro
  → extracts entity "Company X" (organization) → creates project entity mey_companyX

Memory B entry: "Pedro prefers email"
  → extracts entity "Pedro" (person) → embedding match ≥ 0.95 against mey_pedro → reuse
  → links Memory B entry to same mey_pedro entity

Query: "all entries about Pedro" → returns entries from both Memory A and Memory B
```

```
writeMemoryEntry() flow (updated):
  1. Embed content
  2. Dedup check → create/update/skip
  3. If created or updated:
     a. Persist entry to DB
     b. Try: extract entities + upsert + link (sync, best-effort)
        Prompt: "Extract entities and relationships from: <content>"
        → [{ subject: string, relationship: string, object: string }]
        On UPDATE: delete this entry's existing MemoryEntryEntity links first —
        the merged content may reference different entities, so stale links must
        not survive. (Orphaned entities are pruned separately, not here.)
        For each triple:
          - Upsert subject entity (deduplicate by embedding within project)
          - Upsert object entity (deduplicate by embedding within project)
          - Create MemoryEntryEntity links with relationship label
     c. Catch: log warning, continue — entry exists, entities don't
  4. Return { action, entry }
```

#### 5c — Entity-based knowledge queries

The **query surface** for entity-based search (the `entity_ids`, `entity_names`, `actor_ids`,
`entity_types`, `relationship`, and `direction` parameters; query modes; ranking) is owned by
the knowledge module — see [prd-knowledge.md Phase 3 — Entity Graph Queries](./prd-knowledge.md#phase-3--entity-graph-queries--future).
This phase delivers the **memory-side data layer** that Phase 3 queries against:

- `resolveEntitySearch()` resolves entities by ID / name / actor / type and joins through
  `MemoryEntryEntity` to a candidate entry set, applying `relationship` / `direction` filters.
- Entity filters narrow the candidate set; when a `query` is present, vector search ranks within it.
- Memory-type results are enriched with their linked entities (see [Memory Entry ↔ Entity Relationship](#memory-entry--entity-relationship)).

**Unlocks:** Precise, structured knowledge retrieval. Agents can answer "what do we know about this customer?" with exact graph queries instead of hoping vector similarity surfaces the right entries.

---

## Overview

The Memory module provides a project-scoped mechanism for storing and retrieving knowledge. A **memory** is a named container that accumulates atomic facts (entries) via a deduplication and merge algorithm.

A project can have **many memories**, each representing a different knowledge domain (e.g., "Customer Preferences", "Project Context", "Technical Decisions"). Entries written to a memory are automatically deduplicated within that memory's scope.

Searching across memories and documents is handled by the **knowledge module** (`POST /api/v1/knowledge/search`). The memory module owns storage and write logic only — it does not expose its own search endpoint.

This module resolves two roadmap items:

- **Agent Memory (P2)** — persistent, project-scoped knowledge for agents
- **Conversational Memory** — auto-extract facts from conversations

## Key Concepts

### Memory (Container)

A memory is a named, project-scoped knowledge container. It groups related entries and defines the dedup scope.

| Field         | Type             | Required | Description                                                                |
| ------------- | ---------------- | -------- | -------------------------------------------------------------------------- |
| `id`          | string           | auto     | Public ID with `mem_` prefix                                               |
| `project_id`  | string           | yes      | The project this memory belongs to                                         |
| `name`        | string           | yes      | Human-readable name (e.g., "Customer Preferences")                         |
| `description` | string           | no       | Description of what this memory stores                                     |
| `tags`        | array of strings | no       | Tags for categorizing and filtering memories (e.g., `["projectA", "crm"]`) |
| `created_at`  | datetime         | auto     |                                                                            |
| `updated_at`  | datetime         | auto     |                                                                            |

Tags are free-form strings used to group and filter memories. The knowledge search endpoint supports glob-pattern matching on tags (e.g., `user*` matches `user`, `user-prefs`, `user-history`).

### Memory Entry

A memory entry is an atomic piece of knowledge stored inside a memory. Entries are the units of knowledge.

| Field        | Type     | Required | Description                                                                 |
| ------------ | -------- | -------- | --------------------------------------------------------------------------- |
| `id`         | string   | auto     | Public ID with `me_` prefix                                                 |
| `memory_id`  | string   | auto     | The memory this entry belongs to                                            |
| `content`    | string   | yes      | The knowledge content (a single fact, observation, or piece of information) |
| `source`     | string   | auto     | How the entry was created: `manual`, `agent`, `extraction`                  |
| `embedding`  | vector   | auto     | Embedding vector for semantic search (generated on create/update)           |
| `created_at` | datetime | auto     |                                                                             |
| `updated_at` | datetime | auto     |                                                                             |

**Source types:**

- `manual` — created by a user via the REST API
- `agent` — created by an agent via the `write_memory` soat-tool during a generation
- `extraction` — created by the automatic extraction system after a conversation turn

**Design principles:**

- Entries are **atomic** — one fact per entry (e.g., "Customer prefers email communication", not a paragraph mixing multiple facts).
- Entries are **memory-scoped** — deduplication runs within a single memory's entries. Different memories can hold related facts independently.
- Entries are **automatically deduplicated** — the write algorithm prevents duplicate and near-duplicate entries within a memory.
- Entries are **mutable** — they can be merged with new information or manually updated.
- Entries are **embedded** — each entry has an embedding vector computed from its content, enabling semantic search.

### Memory Entity

A memory entity is a noun, object, or concept extracted from memory entries. Entities are **project-scoped** — they live at the project level, not inside a specific memory. This enables cross-memory graph traversal: the same entity can be linked to entries in different memories.

| Field         | Type           | Required | Description                                                           |
| ------------- | -------------- | -------- | --------------------------------------------------------------------- |
| `id`          | string         | auto     | Public ID with `mey_` prefix                                          |
| `project_id`  | string         | auto     | The project this entity belongs to                                    |
| `name`        | string         | yes      | Canonical name (e.g., "Pedro", "Company X")                           |
| `entity_type` | string         | no       | Category: `person`, `organization`, `concept`, `place`, `thing`, etc. |
| `actor_id`    | string         | no       | Links to an actor if this entity represents one                       |
| `properties`  | object (JSONB) | no       | Arbitrary key-value properties (e.g., `{ "role": "CEO" }`)            |
| `embedding`   | vector         | auto     | Embedding vector for fuzzy entity resolution                          |
| `created_at`  | datetime       | auto     |                                                                       |
| `updated_at`  | datetime       | auto     |                                                                       |

**Design principles:**

- Entities are **project-scoped** — deduplicated across all memories in a project. The same real-world concept (e.g., "Pedro") is represented by a single entity, even when referenced from entries in different memories.
- Entities are **deduplicated by a layered strategy** — actor-anchored identity (hard match via `actorId`) takes precedence; for non-actor entities, embedding similarity of `"{name} ({entityType})"` is used with the same two-threshold approach as entries.
- Entities can be **linked to actors** — if an entity corresponds to a known actor in the project, setting `actor_id` provides canonical identity. Any future entity with the same `actor_id` is definitionally the same entity.
- Entities have **properties** — free-form JSONB for structured attributes that don't fit the name/type fields. Properties are enriched on merge (similarity 0.75–0.95).

### Memory Entry ↔ Entity Relationship

A join table links entries to entities with an optional relationship label and direction:

| Field          | Type   | Description                                                           |
| -------------- | ------ | --------------------------------------------------------------------- |
| `entry_id`     | FK     | The memory entry                                                      |
| `entity_id`    | FK     | The entity mentioned in the entry                                     |
| `relationship` | string | The verb/relationship (e.g., "owns", "prefers", "works_at"); nullable |
| `direction`    | enum   | `subject` or `object` — whether the entity is the doer or receiver    |

**Example:** Entry "Pedro owns Company X" produces:

```
Entity: { name: "Pedro", entity_type: "person", actor_id: "act_01" }   # project-scoped
Entity: { name: "Company X", entity_type: "organization" }              # project-scoped

EntryEntity: { entry_id: me_001, entity_id: mey_pedro,    relationship: "owns", direction: "subject" }
EntryEntity: { entry_id: me_001, entity_id: mey_companyX, relationship: "owns", direction: "object" }
```

This enables queries like:

- "All entries about Pedro" → join on entity name (returns entries from **any** memory in the project)
- "What does Pedro own?" → join on entity name + relationship + direction
- "All entries involving actor `act_01`" → join on entity actor_id
- "How are Pedro and Company X related?" → path traversal through shared entries across memories

### Relationship to Documents and Knowledge

Memories and documents are independent storage systems. The **knowledge module** provides a unified search layer across both.

| Concern            | Memories                           | Documents                         | Knowledge                            |
| ------------------ | ---------------------------------- | --------------------------------- | ------------------------------------ |
| What it stores     | Atomic facts (1–2 sentences)       | Full content (files, pages, etc.) | Nothing — query orchestrator only    |
| How content enters | Write algorithm (dedup/merge/skip) | Upload or create                  | —                                    |
| Search endpoint    | —                                  | —                                 | `POST /api/v1/knowledge/search`      |
| Managed by         | System (automatic dedup)           | User (manual upload)              | System (unified retrieval + ranking) |

See the [Knowledge Module PRD](./prd-knowledge.md) for details.

## Write Algorithm

Every write to a memory — manual, agent, or extraction — goes through the same algorithm. The caller provides `content` and the system determines the outcome. Dedup is scoped to the target memory.

```
Input: content (string), memory_id

STEP 1 — EMBED
  Generate embedding for the content.

STEP 2 — SEARCH
  Search existing entries in this memory by cosine similarity.
  Let topMatch = highest-similarity existing entry.

STEP 3 — DECIDE

  CASE 1: topMatch.score ≥ DUPLICATE_THRESHOLD (default 0.95)
    → SKIP. The fact is already known.
    Return { action: "skipped", entry: topMatch }

  CASE 2: topMatch.score ≥ UPDATE_THRESHOLD (default 0.75)
    → MERGE. The fact overlaps with existing knowledge.
    Prompt an LLM:
      "Given the existing fact and the new fact, produce a single
       updated fact that combines both. If they contradict,
       prefer the new information."
      Input: { existing: topMatch.content, new: content }
      Output: { merged: string }
    Update topMatch: content = merged, re-generate embedding, update updated_at.
    Return { action: "updated", entry: topMatch }

  CASE 3: topMatch.score < UPDATE_THRESHOLD (or no existing entries)
    → CREATE. This is genuinely new knowledge.
    Create a new entry with the provided content and embedding.
    Return { action: "created", entry: newEntry }
```

### Why This Algorithm Works

The two-threshold approach handles three scenarios cleanly:

- **High similarity (≥ 0.95):** "The user likes Python" vs "User prefers Python" → same fact, skip.
- **Medium similarity (0.75–0.95):** "The user likes Python" vs "The user likes Python 3.12 specifically" → related, merge into a richer fact.
- **Low similarity (< 0.75):** "The user likes Python" vs "The project deadline is Friday" → unrelated, create new entry.

The LLM-based merge step handles nuance that pure embedding similarity cannot: contradiction resolution, information enrichment, and phrasing consolidation.

### Threshold Configuration

Thresholds can be overridden per request via optional fields in the write endpoint body:

| Field                 | Type   | Default | Description                               |
| --------------------- | ------ | ------- | ----------------------------------------- |
| `duplicate_threshold` | number | 0.95    | Similarity above which content is skipped |
| `update_threshold`    | number | 0.75    | Similarity above which content merges     |

### Examples

**First write — no existing entries:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer prefers email over phone calls" }

→ { "action": "created", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls", ... } }
```

**Duplicate write — same fact rephrased:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "The customer likes email more than phone" }

→ { "action": "skipped", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls", ... } }
```

**Merge write — related fact with new detail:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer prefers email, especially for billing inquiries" }

→ { "action": "updated", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls, especially for billing inquiries", ... } }
```

**Unrelated write — new fact:**

```json
POST /api/v1/memories/mem_abc/entries
{ "content": "Customer fiscal year ends in March" }

→ { "action": "created", "entry": { "id": "me_002", "content": "Customer fiscal year ends in March", ... } }
```

## Write Paths

### 1. Manual Write (REST API)

The user calls `POST /api/v1/memories/:memoryId/entries` with `{ "content": "..." }`. The write algorithm runs within that memory and returns the action taken plus the entry.

### 2. Agent Write (soat-tool)

During a generation, an agent can call the `write_memory` tool with `{ "content": "..." }`. The tool takes **content only** — the target memory is bound from the agent's `knowledge_config.write_memory_id` when the tool is built, so the agent cannot write to arbitrary memories. The write algorithm runs identically.

### 3. Automatic Extraction (post-conversation)

Runs **after a conversation turn completes** (fire-and-forget, does not block the response). This is the only path that extracts multiple facts from a single input.

```
Input: conversation messages[], target memory_id

STEP 1 — EXTRACT CANDIDATE FACTS
  Prompt an LLM with the conversation context:
    "Extract discrete, atomic facts from this conversation.
     Return a JSON array of { content: string } objects.
     Only extract facts that are worth remembering long-term.
     Skip transient information (greetings, acknowledgments, etc.)."

  → candidates: { content: string }[]

  If candidates is empty → STOP (nothing to remember)

STEP 2 — WRITE EACH CANDIDATE
  For each candidate, run the write algorithm against the target memory.
  Each candidate independently results in create, merge, or skip.

STEP 3 — RETURN
  Return a summary: { created: number, updated: number, skipped: number }
```

Extraction is triggered when an agent whose `knowledge_config` has `extraction: true` and a `write_memory_id` completes a non-streaming generation (conversation, session, or direct generate). Facts are written to the `write_memory_id` memory.

## Agent Integration

### Knowledge Config

The Agent model stores a `knowledgeConfig` JSONB field that drives both knowledge retrieval and the
memory write target — no separate join table or attachment endpoints. **Its full schema, the three
retrieval paths (agent config / per-generation / self-retrieval), and the agent-config +
per-generation merge semantics are defined once in the knowledge PRD** — see
[prd-knowledge.md → Knowledge Config](./prd-knowledge.md#knowledge-config) and
[Three Knowledge Retrieval Paths](./prd-knowledge.md#three-knowledge-retrieval-paths). Do not
re-document the shape here; only the memory-owned fields are described below.

**Memory-owned fields on `knowledge_config`:**

- `write_memory_id` — the memory the `write_memory` tool and automatic extraction write to. Binding
  the target here (rather than as a tool argument) is what lets the `write_memory` tool take
  `{ content }` only.
- `extraction` — enables post-turn fact extraction into `write_memory_id` (see Phase 4). `true` uses
  defaults; the object form `{ enabled?, ai_provider_id?, model?, prompt? }` customizes the
  extraction provider/model/prompt.

`memory_ids` / `memory_tags` scope which memories an agent **reads** from; `write_memory_id` scopes
where it **writes**.

### Generation Flow

1. **Merge configs** — combine agent's stored `knowledgeConfig` with per-generation `knowledgeConfig` (if provided) using append semantics.
2. **Search** — call `searchKnowledge()` with the merged config filters and the conversation context as the query.
3. **Inject** — prepend results as system messages, tagged by source.
4. **Generate** — send to LLM with instructions + knowledge + conversation.
5. **Post-generate (async)** — if the config has `extraction: true` and a `write_memory_id`, the extraction algorithm runs on the completed turn, writing new facts to the write memory.

### Agent Memory Tools (soat-tools)

When an agent has a `knowledgeConfig` with memory IDs, it gains access to these tools:

| Tool               | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `write_memory`     | Write content to a memory (system decides: create, merge, or skip)   |
| `search-knowledge` | Search across memories and documents (delegated to knowledge module) |

These tools are gated by the agent's boundary policy.

### Context Injection

Relevant memory entries are injected as system messages before the conversation:

```
[Memory: Customer Preferences] Customer prefers email over phone calls, especially for billing inquiries
[Memory: Customer Preferences] Customer fiscal year ends in March
[Memory: Project Context] The deadline is June 15
```

The system embeds the latest user message and calls `searchKnowledge()` with the agent's `knowledgeConfig` filters to retrieve the top matches.

## Data Model

### Memory Table

| Column      | Type          | Constraints                      |
| ----------- | ------------- | -------------------------------- |
| id          | INTEGER       | PK, auto-increment               |
| publicId    | VARCHAR(32)   | UNIQUE, NOT NULL, `mem_` prefix  |
| projectId   | INTEGER       | FK → Project, NOT NULL           |
| name        | VARCHAR       | NOT NULL                         |
| description | TEXT          | NULL                             |
| tags        | VARCHAR ARRAY | NULL, for categorizing/filtering |
| createdAt   | TIMESTAMP     | NOT NULL                         |
| updatedAt   | TIMESTAMP     | NOT NULL                         |

### MemoryEntry Table

| Column    | Type         | Constraints                    |
| --------- | ------------ | ------------------------------ |
| id        | INTEGER      | PK, auto-increment             |
| publicId  | VARCHAR(32)  | UNIQUE, NOT NULL, `me_` prefix |
| memoryId  | INTEGER      | FK → Memory, NOT NULL          |
| content   | TEXT         | NOT NULL                       |
| source    | VARCHAR(20)  | NOT NULL, enum                 |
| embedding | VECTOR(EMBEDDING_DIMENSIONS) | NOT NULL          |
| createdAt | TIMESTAMP    | NOT NULL                       |
| updatedAt | TIMESTAMP    | NOT NULL                       |

### MemoryEntity Table

| Column     | Type         | Constraints                     |
| ---------- | ------------ | ------------------------------- |
| id         | INTEGER      | PK, auto-increment              |
| publicId   | VARCHAR(32)  | UNIQUE, NOT NULL, `mey_` prefix |
| projectId  | INTEGER      | FK → Project, NOT NULL          |
| name       | VARCHAR      | NOT NULL                        |
| entityType | VARCHAR(50)  | NULL                            |
| actorId    | INTEGER      | FK → Actor, NULL (unique)       |
| properties | JSONB        | NULL, default `{}`              |
| embedding  | VECTOR(EMBEDDING_DIMENSIONS) | NULL            |
| createdAt  | TIMESTAMP    | NOT NULL                        |
| updatedAt  | TIMESTAMP    | NOT NULL                        |

### MemoryEntryEntity Table (join)

| Column       | Type        | Constraints                              |
| ------------ | ----------- | ---------------------------------------- |
| id           | INTEGER     | PK, auto-increment                       |
| entryId      | INTEGER     | FK → MemoryEntry, NOT NULL               |
| entityId     | INTEGER     | FK → MemoryEntity, NOT NULL              |
| relationship | VARCHAR     | NULL (the verb: "owns", "prefers", etc.) |
| direction    | VARCHAR(10) | NOT NULL, enum: `subject`, `object`      |

**Indexes:**

- `UNIQUE (publicId)` on Memory, MemoryEntry, MemoryEntity tables
- `(memoryId)` on MemoryEntry — for listing entries within a memory
- `(projectId)` on MemoryEntity — for listing entities within a project
- `(actorId)` on MemoryEntity — for actor-scoped entity lookups (unique constraint)
- `(entryId)` on MemoryEntryEntity — for listing entities of an entry
- `(entityId)` on MemoryEntryEntity — for listing entries of an entity
- `UNIQUE (entryId, entityId, direction)` on MemoryEntryEntity — prevent duplicate links
- `HNSW (embedding)` on MemoryEntry and MemoryEntity — for cosine similarity search

### Agent `knowledgeConfig` Field

Stored as JSONB on the `agents` table; no join table needed — the agent stores its knowledge
retrieval config inline. The **canonical `KnowledgeConfig` schema** (all read-scope and write-side
fields) lives in the knowledge PRD — see
[prd-knowledge.md → Knowledge Config](./prd-knowledge.md#knowledge-config). The memory-owned fields
(`write_memory_id`, `extraction`) are described under [Agent Integration](#knowledge-config) above.

## Permissions

### Memory CRUD

| Permission              | Endpoint                            |
| ----------------------- | ----------------------------------- |
| `memories:CreateMemory` | `POST /api/v1/memories`             |
| `memories:ListMemories` | `GET /api/v1/memories`              |
| `memories:GetMemory`    | `GET /api/v1/memories/:memoryId`    |
| `memories:UpdateMemory` | `PUT /api/v1/memories/:memoryId`    |
| `memories:DeleteMemory` | `DELETE /api/v1/memories/:memoryId` |

### Entry Operations

| Permission                   | Endpoint                                             |
| ---------------------------- | ---------------------------------------------------- |
| `memories:WriteMemoryEntry`  | `POST /api/v1/memories/:memoryId/entries`            |
| `memories:ListMemoryEntries` | `GET /api/v1/memories/:memoryId/entries`             |
| `memories:GetMemoryEntry`    | `GET /api/v1/memories/:memoryId/entries/:entryId`    |
| `memories:UpdateMemoryEntry` | `PUT /api/v1/memories/:memoryId/entries/:entryId`    |
| `memories:DeleteMemoryEntry` | `DELETE /api/v1/memories/:memoryId/entries/:entryId` |

### Entity Operations

| Permission                    | Endpoint                            |
| ----------------------------- | ----------------------------------- |
| `memories:ListMemoryEntities` | `GET /api/v1/entities`                      |
| `memories:GetMemoryEntity`    | `GET /api/v1/entities/:entityId`            |
| `memories:UpdateMemoryEntity` | `PUT /api/v1/entities/:entityId`            |
| `memories:DeleteMemoryEntity` | `DELETE /api/v1/entities/:entityId`         |
| `memories:ListEntityEntries`  | `GET /api/v1/entities/:entityId/entries`    |

Entity creation is automatic (via extraction during `writeMemoryEntry`). No `CreateMemoryEntity` permission needed — it piggybacks on `WriteMemoryEntry`.

### Knowledge Config Permissions

Updating an agent's `knowledgeConfig` uses `agents:UpdateAgent` (standard agent update).

## REST API

All body fields use `snake_case` per project convention.

### Memory CRUD

| Method | Path                         | Description                          |
| ------ | ---------------------------- | ------------------------------------ |
| POST   | `/api/v1/memories`           | Create a memory                      |
| GET    | `/api/v1/memories`           | List memories in accessible projects |
| GET    | `/api/v1/memories/:memoryId` | Get a memory by ID                   |
| PUT    | `/api/v1/memories/:memoryId` | Update a memory                      |
| DELETE | `/api/v1/memories/:memoryId` | Delete a memory and all its entries  |

### Entry Operations

| Method | Path                                          | Description                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------ |
| POST   | `/api/v1/memories/:memoryId/entries`          | Write content (system decides: create, merge, or skip) |
| GET    | `/api/v1/memories/:memoryId/entries`          | List entries in a memory                               |
| GET    | `/api/v1/memories/:memoryId/entries/:entryId` | Get an entry by ID                                     |
| PUT    | `/api/v1/memories/:memoryId/entries/:entryId` | Manually update an entry (bypasses dedup)              |
| DELETE | `/api/v1/memories/:memoryId/entries/:entryId` | Delete an entry                                        |

### Entity Operations

| Method | Path                                 | Description                                     |
| ------ | ------------------------------------ | ----------------------------------------------- |
| GET    | `/api/v1/entities`                   | List entities in accessible projects            |
| GET    | `/api/v1/entities/:entityId`         | Get an entity by ID                             |
| PUT    | `/api/v1/entities/:entityId`         | Update entity (name, type, properties, actorId) |
| DELETE | `/api/v1/entities/:entityId`         | Delete an entity and its entry links            |
| GET    | `/api/v1/entities/:entityId/entries` | List entries linked to an entity                |

Entities are created automatically during `writeMemoryEntry()` — no `POST` endpoint. Users can update or delete extracted entities via `PUT`/`DELETE`. Entities are project-scoped; filter by `project_id` query parameter on `GET /api/v1/entities`.

### Agent Knowledge Config

No separate endpoints — use the standard agent update endpoint:

| Method | Path                      | Description                               |
| ------ | ------------------------- | ----------------------------------------- |
| PUT    | `/api/v1/agents/:agentId` | Update agent including `knowledge_config` |
