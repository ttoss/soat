# PRD: Knowledge Module

## Implementation Status

| Component                          | Status         | Notes                                                                                            |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `knowledge.ts` lib                 | ✅ Implemented | `searchKnowledge()`, `resolveDocumentSearch()`, `mapDocument()`, types                           |
| `POST /api/v1/knowledge/search`    | ✅ Implemented | Document search works end-to-end with auth, policy, validation                                   |
| Chunk-level document search        | ✅ Implemented | Search runs against `DocumentChunk.embedding`, not `Document`; results carry `chunk_id` and `page` (issue #244 / PR #245) |
| OpenAPI spec (`knowledge.yaml`)    | ✅ Implemented | `searchKnowledge` operationId, `KnowledgeResult` schema                                          |
| Permission (`SearchKnowledge`)     | ✅ Implemented | `knowledge.json` with `knowledge:SearchKnowledge`                                                |
| Router mounted in `index.ts`       | ✅ Implemented | Knowledge routes registered                                                                      |
| Module docs page                   | ✅ Implemented | `packages/website/docs/modules/knowledge.md`                                                     |
| Migration from `documentSearch.ts` | ✅ Done        | `documentSearch.ts` removed; `documents.ts` re-exports from `knowledge.ts`                       |
| `search-knowledge` soat-tool       | ✅ Implemented | Auto-generated from OpenAPI YAML via `soatTools.ts` (kebab-case of the `searchKnowledge` operationId) |
| Memory source integration          | ✅ Implemented | `memory_ids`, `memory_tags` filters; `resolveMemorySearch()` in `knowledgeMemory.ts`; `source_type: "memory"` in results |
| `document_filters` parameter       | ✅ Implemented | Flat `document_paths` and `document_ids` fields in OpenAPI spec                                  |
| Memory entry ranking/merge         | ✅ Implemented | Document + memory results interleaved by score in `searchKnowledge()`                            |
| Entity graph queries               | ❌ Future      | `entity_ids`, `entity_names`, `actor_ids` filters; `resolveEntitySearch()`                       |
| Hybrid vector + entity search      | ❌ Future      | Entity filter narrows candidates, vector search ranks within                                     |
| Graph traversal queries            | ❌ Future      | `relationship` and `direction` filters for edge-based traversal                                  |
| Post-conversation extraction       | ✅ Implemented | Fire-and-forget trigger on completed turns; facts written via `writeMemoryEntry()` (see prd-memories.md Phase 4) |

## Implementation Phases

### Phase 1 — Document Search ✅ Complete

**Goal:** Unified knowledge search across documents using pgvector similarity.

**Deliverables:**

- `searchKnowledge()` lib function (document source only)
- `POST /api/v1/knowledge/search` endpoint with auth, policy, validation
- `SearchKnowledge` permission, OpenAPI spec, module docs
- `search-knowledge` soat-tool (auto-generated from OpenAPI)
- Migration: `documentSearch.ts` removed; `documents.ts` re-exports from `knowledge.ts`

> **Update (DocumentChunk model, issue #244):** Document search is now **chunk-level**. The
> `embedding` column moved off `Document` onto a new `DocumentChunk` model — one `Document`
> has many chunks, each with its own pgvector embedding. `resolveDocumentSearch()` runs the
> cosine search against `DocumentChunk.embedding` (joined back to `Document` → `File`), and
> each document result carries `chunk_id` and `page` so matches can cite a specific page.
> A plain-text document is the degenerate `N=1` case (one chunk, `page = null`).

---

### Phase 2 — Memory Source Integration ✅ Complete

**Goal:** Extend `searchKnowledge()` to query memory entries alongside documents and return interleaved results ranked by score.

**Deliverables:**

- `memory_ids` and `memory_tags` (glob) parameters on `POST /api/v1/knowledge/search`
- `document_paths` and `document_ids` flat parameters (replacing nested `document_filters`)
- `resolveMemorySearch()` lib function in `knowledgeMemory.ts` (imported by `knowledge.ts`) — runs pgvector cosine search on `MemoryEntry.embedding`, resolves memories by IDs and tag patterns
- Parallel execution: `resolveDocumentSearch()` and `resolveMemorySearch()` run concurrently, results merged and re-ranked by score
- `source_type: "memory"` added to `KnowledgeResult`
- OpenAPI spec updated → SDK/CLI regenerated → `search-knowledge` soat-tool gains memory parameters automatically
- Tests: memory-only search, document-only search, mixed search, tag glob matching, min_score filtering

**Unlocks:** Phase 2 of the Memory module (agent read path). Agents can recall facts from memories using the existing `search-knowledge` soat-tool.

---

### Phase 3 — Entity Graph Queries ❌ Future

**Goal:** Extend `searchKnowledge()` with entity-based filters so callers can query knowledge by structured graph traversal — not just vector similarity. Enables precise queries like "everything about Pedro", "what does Company X own?", and "all knowledge linked to actor `act_01`".

**Dependencies:** Phase 2 of this PRD (memory integration) must be complete. Memory entity graph layer (prd-memories.md Phase 5) must be complete.

**New parameters on `POST /api/v1/knowledge/search`:**

| Parameter      | Type     | Description                                                                               |
| -------------- | -------- | ----------------------------------------------------------------------------------------- |
| `entity_ids`   | string[] | Filter entries linked to these entity IDs (`mey_...`)                                     |
| `entity_names` | string[] | Filter entries linked to entities matching these names (case-insensitive substring match) |
| `actor_ids`    | string[] | Filter entries linked to entities that have these actor IDs (`act_...`)                   |
| `entity_types` | string[] | Filter entries linked to entities of these types (`person`, `organization`, etc.)         |
| `relationship` | string   | Filter by relationship label (the verb: `owns`, `works_at`, `prefers`)                    |
| `direction`    | string   | Filter by direction: `subject` (entity is the doer) or `object` (entity is the receiver)  |

All entity parameters are optional and compose with existing vector/memory/document filters.

**Query modes:**

| Mode                   | Parameters                                  | Behavior                                                        |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Vector-only (existing) | `query`                                     | Cosine similarity across all sources                            |
| Entity-only            | `entity_ids` or `entity_names`              | All entries linked to those entities, ordered by `updated_at`   |
| Actor-only             | `actor_ids`                                 | All entries linked to entities mapped to those actors           |
| Hybrid (vector+entity) | `query` + entity filters                    | Entity filter narrows candidate set, vector search ranks within |
| Graph traversal        | `entity_ids` + `relationship`               | Follow specific relationships from an entity                    |
| Full graph             | `entity_ids` + `relationship` + `direction` | Directed edge traversal                                         |

**Deliverables:**

- `resolveEntitySearch()` lib function in `knowledge.ts` — resolves entities by ID/name/actor, joins through `MemoryEntryEntity` to find linked entries
- Entity filters compose with memory filters: entity match narrows the entry set, memory/tag filters narrow the memory scope; intersection of both
- When `query` is provided alongside entity filters: entity match produces candidate entries, then vector similarity ranks them
- When `query` is absent and only entity filters are provided: return all matching entries ordered by `updated_at` descending (no ranking needed)
- `relationship` and `direction` filters applied on the `MemoryEntryEntity` join — only entries connected via the specified edge
- Response enrichment: memory-type results include an `entities` array showing linked entities and their relationships
- OpenAPI spec updated → SDK/CLI regenerated → `search-knowledge` soat-tool gains entity parameters automatically
- Tests: entity-only search, actor-only search, hybrid vector+entity, relationship traversal, direction filtering, entity+memory scope intersection

**Example queries:**

```jsonc
// "What do we know about Pedro?"
{ "project_id": "prj_01", "entity_names": ["Pedro"] }

// "What does Pedro own?" (graph traversal)
{ "project_id": "prj_01", "entity_names": ["Pedro"], "relationship": "owns", "direction": "subject" }

// "Everything about actor act_01" (actor-anchored)
{ "project_id": "prj_01", "actor_ids": ["act_01"] }

// "Pedro-related entries that mention billing" (hybrid: entity narrows, vector ranks)
{ "project_id": "prj_01", "query": "billing", "entity_names": ["Pedro"] }

// "All people connected to Company X"
{ "project_id": "prj_01", "entity_names": ["Company X"], "entity_types": ["person"] }

// "Actor act_01 relationships in CRM memories only" (entity + memory scope)
{ "project_id": "prj_01", "actor_ids": ["act_01"], "memory_tags": ["crm"] }
```

**Unlocks:** Phase 5c of the Memory module (entity-based knowledge queries). Agents can answer structured questions about entities and relationships using the same `search-knowledge` tool.

---

### Phase 4 — Post-Conversation Extraction (async) ✅ Complete

**Goal:** Wire the memory extraction algorithm (defined in prd-memories.md Phase 4) into the conversation/agent pipeline so facts are extracted automatically after each turn — with no changes needed to the caller.

**Deliverables (as implemented — see prd-memories.md Phase 4 for full details):**

- ✅ Fire-and-forget extraction trigger after completed turns — non-blocking; fired from `conversationGeneration.ts` (covers conversations and sessions) and the direct `POST /agents/:id/generate` route. *(Design deviation: the trigger lives at the post-completion call sites instead of inside `createGeneration()`, keeping the generation pipeline extraction-free and the trigger covered by REST integration tests.)*
- ✅ Trigger condition: **opt-in** — agent's `knowledgeConfig` has `extraction: true` and a `write_memory_id` (the write target). *(Design deviation: opt-in rather than opt-out, so enabling memory retrieval never silently adds LLM extraction cost.)*
- ✅ `runMemoryExtraction()` in `memoryExtraction.ts` — runs the extraction completion (`memoryExtractionCompletion.ts`, plain completion on the agent's own provider/model), then `writeMemoryEntry()` for each candidate with `source: 'extraction'`
- ✅ Extraction result (`{ candidates, created, updated, skipped }`) stored on the generation record's `metadata.extraction`
- ✅ Tests: trigger conditions, dedup during extraction, malformed output, completion failure (`memoryExtraction.test.ts` in `rest/` and `lib/`)

**Unlocks:** Zero-effort conversational memory — agents accumulate knowledge just by talking, no explicit `write_memory` calls needed.

---

## Overview

The Knowledge module is the **unified retrieval layer** for agents. It searches across all knowledge sources — documents and memory entries — and returns ranked, merged results.

The knowledge module does not own any data. It orchestrates queries against data modules (documents, memories) and merges the results into a single ranked list. This decouples agents from the specifics of how knowledge is stored.

The migration from `POST /api/v1/documents/search` to `POST /api/v1/knowledge/search` is **already complete**. The old endpoint and `documentSearch.ts` have been removed. The `documents.ts` module re-exports `mapDocument`, `resolveDocumentSearch`, `DocumentQueryConfig`, and `QueryDocumentResult` from `knowledge.ts` for backward compatibility of internal imports.

## Key Concepts

### Unified Search

A single endpoint accepts a query and optional filters that scope which sources to search:

- **Memory IDs** — search entries within specific memories by ID
- **Memory tags** — search entries in memories matching tag patterns (supports glob: `user*` matches `user`, `user-prefs`, `user-history`)
- **Document paths/IDs** — filter documents by paths or document IDs
- **Entity IDs/names** — search entries linked to specific entities (graph lookup)
- **Actor IDs** — search entries linked to entities mapped to specific actors
- **Relationship/direction** — traverse specific edges in the entity graph

If no source filters are provided, the search runs across all accessible documents and memories in the project.

Memory IDs and memory tags can be combined — the search includes entries from memories that match **either** filter (union).

### Vector vs Graph Queries

The knowledge endpoint supports two complementary query strategies that can be used independently or combined:

| Strategy   | When to use                                            | Parameters                                                |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------- |
| **Vector** | Semantic similarity — "find things related to billing" | `query` (required)                                        |
| **Graph**  | Structural lookup — "what does Pedro own?"             | `entity_ids`, `entity_names`, `actor_ids`, `relationship` |
| **Hybrid** | Narrowed similarity — "billing info about Pedro"       | `query` + entity filters                                  |

**Vector-only:** `query` drives cosine similarity across all sources. No entity filters.

**Graph-only:** Entity filters produce a set of matching entries via `MemoryEntryEntity` joins. No embedding needed — results are ordered by `updated_at`. This is the "database search" path: exact, exhaustive, no fuzzy ranking.

**Hybrid:** Entity filters narrow the candidate set first, then `query` ranks within that set by cosine similarity. Useful when you know _who_ you're asking about but want semantic relevance within that scope.

### Actor-Anchored Queries

Actors are first-class citizens in the entity graph. Querying by `actor_ids` finds all entries linked to entities that represent those actors — across all memories in the project.

This enables queries like:

- "All knowledge about this customer" → `{ actor_ids: ["act_customer"] }`
- "What has this user said about preferences?" → `{ actor_ids: ["act_user"], query: "preferences" }`
- "All actors connected to Company X" → `{ entity_names: ["Company X"] }` → results include entity metadata with `actor_id` when available

### Source-Tagged Results

Every result includes a `source_type` field so the caller knows where each piece of knowledge came from. Two source types are supported: `document` and `memory`. Entity-graph results (Phase 3) will also use `source_type: "memory"` since entities link to memory entries.

### Ranking

Results from all sources are ranked by cosine similarity score against the query embedding. Documents and memory entries are interleaved in a single list ordered by score.

## Search Algorithm

```
Input: query (string)?, project_id, memory_ids[]?, memory_tags[]?, document_paths[]?,
       document_ids[]?, entity_ids[]?, entity_names[]?, actor_ids[]?, entity_types[]?,
       relationship?, direction?, min_score?, limit?

STEP 1 — DETERMINE MODE
  has_query   = query is provided and non-empty
  has_entity  = entity_ids or entity_names or actor_ids is provided
  mode        = has_query && has_entity ? "hybrid"
              : has_query               ? "vector"
              : has_entity              ? "graph"
              : "vector"  (default — query required if no entity filters)

STEP 2 — EMBED (skip if mode = "graph")
  Generate embedding for the query.

STEP 3 — RESOLVE MEMORY SCOPE
  Collect target memories from:
    - memory_ids (if provided): memories matching these IDs
    - memory_tags (if provided): memories whose tags match any pattern (glob)
  Union the two sets. If neither is provided, use all memories in the project.

STEP 4 — RESOLVE ENTITY SCOPE (skip if mode = "vector")
  Collect candidate entry IDs:
    a. Resolve entities:
       - entity_ids → direct lookup
       - entity_names → case-insensitive substring match on MemoryEntity.name within project
       - actor_ids → lookup MemoryEntity where actorId IN actor_ids within project
       - entity_types → filter resolved entities by entityType
    b. Join through MemoryEntryEntity to get entry IDs:
       - If relationship is provided, filter joins where relationship matches
       - If direction is provided, filter joins where direction matches
    c. Result: a set of entry_ids linked to the matched entities

STEP 5 — SEARCH SOURCES (parallel)

  IF mode = "graph":
    Fetch memory entries by ID set from step 4.
    Intersect with memory scope from step 3 (if memory filters were provided).
    Order by updated_at descending (no cosine ranking).
    Enrich each result with linked entities and relationships.
    Tag each result with source_type = "memory".

  IF mode = "vector" or "hybrid":
    IF target memories is non-empty:
      Search memory entries within resolved memories by cosine similarity.
      IF mode = "hybrid": intersect results with entry_ids from step 4.
      Tag each result with source_type = "memory".

    IF document_paths or document_ids is provided (or no filters → all documents in project):
      Search documents by cosine similarity (existing resolveDocumentSearch logic).
      Tag each result with source_type = "document".
      (Entity filters do not apply to documents — documents have no entity links.)

STEP 6 — ENRICH ENTITY METADATA
  For memory-type results (in any mode), attach linked entities:
    Query MemoryEntryEntity + MemoryEntity for each result entry.
    Add entities[] array with { entity_id, name, entity_type, actor_id, relationship, direction }.

STEP 7 — MERGE & RANK
  Combine all results into a single list.
  IF mode = "graph": sort by updated_at descending.
  ELSE: sort by score descending.
  Apply min_score filter (only when query was provided).
  Apply limit.

STEP 8 — RETURN
  Return the merged, ranked list.
```

## REST API

All body fields use `snake_case` per project convention.

### Search

#### Vector search (existing)

```json
{
  "query": "customer communication preferences",
  "project_id": "prj_01",
  "memory_ids": ["mem_abc", "mem_def"],
  "memory_tags": ["projectA", "user*"],
  "document_paths": ["/sales/"],
  "document_ids": ["doc_01"],
  "min_score": 0.5,
  "limit": 10
}
```

`memory_tags` supports glob patterns: `user*` matches memories tagged `user`, `user-prefs`, `user-history`, etc. When both `memory_ids` and `memory_tags` are provided, the search includes entries from the **union** of both sets.

#### Graph search — entity lookup

```jsonc
// "What do we know about Pedro?"
{
  "project_id": "prj_01",
  "entity_names": ["Pedro"]
}

// "What does Pedro own?" (directed graph traversal)
{
  "project_id": "prj_01",
  "entity_names": ["Pedro"],
  "relationship": "owns",
  "direction": "subject"
}

// "Everything about this actor across all memories"
{
  "project_id": "prj_01",
  "actor_ids": ["act_01"]
}

// "All people connected to Company X"
{
  "project_id": "prj_01",
  "entity_names": ["Company X"],
  "entity_types": ["person"]
}
```

#### Hybrid search — entity + vector

```jsonc
// "Billing info about Pedro" — entity narrows, vector ranks
{
  "project_id": "prj_01",
  "query": "billing",
  "entity_names": ["Pedro"]
}

// "Actor preferences in CRM memories" — entity + memory scope + vector
{
  "project_id": "prj_01",
  "query": "preferences",
  "actor_ids": ["act_01"],
  "memory_tags": ["crm"]
}
```

#### Response

Vector/hybrid mode (results ranked by score):

```json
{
  "results": [
    {
      "source_type": "memory",
      "memory_id": "mem_abc",
      "entry_id": "me_001",
      "content": "Customer prefers email over phone calls, especially for billing inquiries",
      "score": 0.89,
      "entities": [
        {
          "entity_id": "mey_pedro",
          "name": "Pedro",
          "entity_type": "person",
          "actor_id": "act_01",
          "relationship": "prefers",
          "direction": "subject"
        }
      ]
    },
    {
      "source_type": "document",
      "document_id": "doc_42",
      "chunk_id": "dchunk_19",
      "page": 3,
      "file_id": "fil_07",
      "content": "Communication policy: all billing inquiries should be handled via email...",
      "score": 0.82
    },
    {
      "source_type": "memory",
      "memory_id": "mem_def",
      "entry_id": "me_003",
      "content": "Customer timezone is EST",
      "score": 0.52,
      "entities": []
    }
  ]
}
```

Graph-only mode (results ordered by `updated_at`, no score):

```json
{
  "results": [
    {
      "source_type": "memory",
      "memory_id": "mem_abc",
      "entry_id": "me_001",
      "content": "Pedro owns Company X",
      "entities": [
        {
          "entity_id": "mey_pedro",
          "name": "Pedro",
          "entity_type": "person",
          "actor_id": "act_01",
          "relationship": "owns",
          "direction": "subject"
        },
        {
          "entity_id": "mey_companyX",
          "name": "Company X",
          "entity_type": "organization",
          "relationship": "owns",
          "direction": "object"
        }
      ]
    },
    {
      "source_type": "memory",
      "memory_id": "mem_def",
      "entry_id": "me_007",
      "content": "Pedro prefers email communication",
      "entities": [
        {
          "entity_id": "mey_pedro",
          "name": "Pedro",
          "entity_type": "person",
          "actor_id": "act_01",
          "relationship": "prefers",
          "direction": "subject"
        }
      ]
    }
  ]
}
```

### Endpoints

| Method | Path                       | Description                                         |
| ------ | -------------------------- | --------------------------------------------------- |
| POST   | `/api/v1/knowledge/search` | Unified semantic search across documents & memories |

## Agent Integration

### Knowledge Config

Agents store a `knowledgeConfig` JSONB field that mirrors the `searchKnowledge` parameters. This replaces the previous `AgentMemory` join table approach — no separate attachment endpoints needed.

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_abc"],
    "memory_tags": ["crm"],
    "document_paths": ["/sales/"],
    "actor_ids": ["act_customer"],
    "min_score": 0.5,
    "limit": 10
  }
}
```

Simple case (one memory): `{ "knowledge_config": { "memory_ids": ["mem_abc"] } }`

Actor-scoped case: `{ "knowledge_config": { "actor_ids": ["act_customer"] } }` — retrieves all knowledge about a specific actor across all memories

### Three Knowledge Retrieval Paths

| Path                                                             | When                            | Who decides                   | Injected as                      |
| ---------------------------------------------------------------- | ------------------------------- | ----------------------------- | -------------------------------- |
| **Agent config** (`knowledge_config` on agent)                   | Every generation, automatically | Agent creator (at setup time) | System messages                  |
| **Per-generation request** (`knowledge_config` in generate body) | One specific generation         | Caller (at request time)      | System messages                  |
| **Agent self-retrieval**                                         | During generation, dynamically  | The agent (LLM decides)       | Via `search-knowledge` soat-tool |

### Merge Behavior (Agent Config + Per-Generation)

When both are provided, they **append** (not override):

- **Array fields** (`memory_ids`, `memory_tags`, `document_paths`, `document_ids`, `entity_ids`, `entity_names`, `actor_ids`, `entity_types`) → union
- **Scalar fields** (`min_score`, `limit`, `relationship`, `direction`) → per-generation overrides agent config

```
Agent config:       { memory_ids: ["mem_abc"], actor_ids: ["act_01"], limit: 5 }
Per-generation:     { memory_ids: ["mem_xyz"], document_paths: ["/docs/"] }
→ Merged:           { memory_ids: ["mem_abc", "mem_xyz"], actor_ids: ["act_01"], document_paths: ["/docs/"], limit: 5 }
```

### Context Assembly

When an agent generates a response:

1. **Merge configs** — append the agent's stored `knowledgeConfig` with the per-generation `knowledgeConfig` (if provided).
2. Call `searchKnowledge` with the merged filters and the conversation context as the query.
3. Inject results as **system messages**, tagged by source:

```
[Memory: Customer Preferences] Customer prefers email over phone calls
[Document: /sales/comm-policy.md] Communication policy: all billing inquiries should be handled via email...
```

### soat-tools

| Tool               | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| `search-knowledge` | Search across memories and documents for relevant knowledge |

This tool replaces the separate document-search tool. The `write_memory` tool stays in the memory module.

## Migration from `documentSearch` (Completed)

The migration is **already done**. This section is kept for historical context.

| Before                          | After (current state)                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `POST /api/v1/documents/search` | Removed — replaced by `POST /api/v1/knowledge/search`        |
| `src/lib/documentSearch.ts`     | Removed — logic lives in `src/lib/knowledge.ts`              |
| `resolveDocumentSearch()`       | Exported from `knowledge.ts` (used by document CRUD routes)  |
| `mapDocument()` (shared mapper) | Exported from `knowledge.ts` (re-exported by `documents.ts`) |
| `search_documents` soat-tool    | Replaced by `search-knowledge` soat-tool (auto-generated)    |

`documents.ts` re-exports `mapDocument`, `resolveDocumentSearch`, `DocumentQueryConfig`, and `QueryDocumentResult` from `knowledge.ts` so existing internal imports continue to work without changes.

## Implementation Architecture

### Current state (document + memory search)

```
src/lib/knowledge.ts
├── searchKnowledge()          — public: unified search across documents and memories, merged by score
├── resolveDocumentSearch()    — exported: chunk-level document vector search with policy/path/id filters
├── mapDocument()              — exported: shared mapper for document CRUD
├── mapChunkResult()           — private: maps a DocumentChunk row (joined to Document → File); content comes from the chunk, not disk; adds chunk_id + page
├── buildDocWhere()            — private: builds Sequelize where for document IDs
├── buildFileInclude()         — private: builds File include with project/path filters
├── filterByScore()            — private: filters results below min_score
└── types                      — KnowledgeResult, DocumentQueryConfig, QueryDocumentResult

Document search queries the `DocumentChunk` table (`"DocumentChunk"."embedding" <=> queryEmbedding`),
joining `DocumentChunk → Document → File → Project`. The previous `mapRawDocument()` path, which
read file contents from disk per result, has been removed — chunk content lives in the row.

src/lib/knowledgeMemory.ts
├── resolveMemorySearch()      — exported: cosine search against MemoryEntry table
└── resolveMemoryIdsByGlobTags() — private: glob tag patterns → memory IDs (ILIKE on unnest(tags))
```

### Planned state (after entity integration)

```
src/lib/knowledge.ts (additions)
├── resolveEntitySearch()      — private: entity/actor lookup → entry IDs via MemoryEntryEntity joins
├── enrichEntityMetadata()     — private: attach linked entities to memory-type results
└── mergeAndRank()             — private: combine + sort (by score or updated_at) + filter results
```

## Permissions

| Permission                  | Endpoint                        |
| --------------------------- | ------------------------------- |
| `knowledge:SearchKnowledge` | `POST /api/v1/knowledge/search` |

The caller must also have read access to the memories and documents being searched. The knowledge module delegates permission checks to the underlying data modules.

## Future

The knowledge module is designed to accommodate additional retrieval strategies:

| Capability             | Status    | Description                                                          |
| ---------------------- | --------- | --------------------------------------------------------------------- |
| Document search        | ✅ Done   | Cosine similarity on document embeddings                              |
| Memory search          | ✅ Done   | Cosine similarity on memory entry embeddings, merged with documents   |
| Entity graph queries   | ❌ Future | Exact entry lookup via entity/relationship joins (Phase 3)            |
| Hybrid vector + entity | ❌ Future | Entity filter narrows candidates, vector search ranks within (Phase 3)|

## Data Model

The knowledge module owns **no tables**. It queries:

- `DocumentChunk` + `Document` + `File` (from the documents module) — cosine search on `DocumentChunk.embedding`, filtered by paths, tags, document IDs; results carry `chunk_id` + `page` ✅
- `Memory` + `MemoryEntry` (from the memory module) — filtered by `memory_ids` and `memory_tags` (glob) ✅
- `MemoryEntity` + `MemoryEntryEntity` (from the memory module) — entity graph filters ❌ (Phase 3; depends on prd-memories.md Phase 5)

## OpenAPI Spec

The `knowledge.yaml` spec defines one operation:

- `POST /api/v1/knowledge/search` — `searchKnowledge`

The legacy `POST /api/v1/documents/search` operation has already been removed from `documents.yaml` (see [Migration](#migration-from-documentsearch-completed)).
