# PRD: Knowledge Module

## Implementation Status

| Component                          | Status         | Notes                                                                                            |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `knowledge.ts` lib                 | ✅ Implemented | `searchKnowledge()`, `resolveDocumentSearch()`, `mapDocument()`, types                           |
| `POST /api/v1/knowledge/search`    | ✅ Implemented | Document search works end-to-end with auth, policy, validation                                   |
| OpenAPI spec (`knowledge.yaml`)    | ✅ Implemented | `searchKnowledge` operationId, `KnowledgeResult` schema                                          |
| Permission (`SearchKnowledge`)     | ✅ Implemented | `knowledge.json` with `knowledge:SearchKnowledge`                                                |
| Router mounted in `index.ts`       | ✅ Implemented | Knowledge routes registered                                                                      |
| Module docs page                   | ✅ Implemented | `packages/website/docs/modules/knowledge.md`                                                     |
| Migration from `documentSearch.ts` | ✅ Done        | `documentSearch.ts` removed; `documents.ts` re-exports from `knowledge.ts`                       |
| `searchKnowledge` soat-tool        | ✅ Implemented | Auto-generated from OpenAPI YAML via `soatTools.ts`                                              |
| Memory source integration          | ✅ Implemented | `memory_ids`, `memory_tags` filters; `resolveMemorySearch()`; `source_type: "memory"` in results |
| `document_filters` parameter       | ✅ Implemented | Flat `document_paths` and `document_ids` fields in OpenAPI spec                                  |
| Memory entry ranking/merge         | ✅ Implemented | Document + memory results interleaved by score in `searchKnowledge()`                            |
| Knowledge ↔ Entities integration   | ❌ Future      | `traverseEntities()` as third source; `source_type: "entity"` in results                         |
| Post-conversation extraction       | ❌ Future      | Async trigger on conversation turn; facts written via `writeMemoryEntry()`                       |

## Implementation Phases

### Phase 1 — Document Search ✅ Complete

**Goal:** Unified knowledge search across documents using pgvector similarity.

**Deliverables:**

- `searchKnowledge()` lib function (document source only)
- `POST /api/v1/knowledge/search` endpoint with auth, policy, validation
- `SearchKnowledge` permission, OpenAPI spec, module docs
- `search_knowledge` soat-tool (auto-generated from OpenAPI)
- Migration: `documentSearch.ts` removed; `documents.ts` re-exports from `knowledge.ts`

---

### Phase 2 — Memory Source Integration ✅ Complete

**Goal:** Extend `searchKnowledge()` to query memory entries alongside documents and return interleaved results ranked by score.

**Deliverables:**

- `memory_ids` and `memory_tags` (glob) parameters on `POST /api/v1/knowledge/search`
- `document_paths` and `document_ids` flat parameters (replacing nested `document_filters`)
- `resolveMemorySearch()` lib function in `knowledge.ts` — runs pgvector cosine search on `MemoryEntry.embedding`, resolves memories by IDs and tag patterns
- Parallel execution: `resolveDocumentSearch()` and `resolveMemorySearch()` run concurrently, results merged and re-ranked by score
- `source_type: "memory"` added to `KnowledgeResult`
- OpenAPI spec updated → SDK/CLI regenerated → `search_knowledge` soat-tool gains memory parameters automatically
- Tests: memory-only search, document-only search, mixed search, tag glob matching, min_score filtering

**Unlocks:** Phase 2 of the Memory module (agent read path). Agents can recall facts from memories using the existing `search_knowledge` soat-tool.

---

### Phase 5 — Knowledge ↔ Entities Integration ❌ Future

**Goal:** Add entity/relationship graph traversal as a third knowledge source alongside documents and memories.

**Dependencies:** Entities module (all components in [prd-entities.md](./prd-entities.md)) must be complete first.

**Deliverables:**

- `traverseEntities()` lib function in `knowledge.ts` — given a query and project scope, traverse the entity/relationship graph and return relevant entities/relationships with a score
- `entity_filters` parameter on `POST /api/v1/knowledge/search` — scope graph traversal by entity type or relationship verb
- `source_type: "entity"` added to `KnowledgeResult` — each entity result carries `entity_id`, `relationship_path`, `content` (serialized from entity properties), and `score`
- Parallel execution: document search, memory search, and entity traversal run concurrently; results merged and re-ranked by score
- OpenAPI spec update → SDK/CLI regeneration → `search_knowledge` soat-tool gains entity parameters automatically
- Tests: entity-only search, mixed (document + memory + entity) search, relationship path filtering

**Unlocks:** Agents that can reason over structured domain knowledge — "What companies does actor_1 own? What is their MRR?"

---

### Phase 6 — Post-Conversation Extraction (async) ❌ Future

**Goal:** Wire the memory extraction algorithm (defined in prd-memories.md Phase 4) into the conversation/agent pipeline so facts are extracted automatically after each turn — with no changes needed to the caller.

**Dependencies:** Phase 2 of this PRD (memory integration) must be complete. Memory extraction algorithm (prd-memories.md Phase 4) must be complete.

**Deliverables:**

- Fire-and-forget extraction trigger at the end of `createGeneration()` — non-blocking; does not affect generation latency
- Trigger condition: agent's merged `knowledgeConfig` includes at least one `memory_id` and `extraction` is not disabled
- Calls `extractMemoryFacts({ messages, memoryIds })` — runs LLM to extract candidate facts, then `writeMemoryEntry()` for each
- Extraction result (`{ created, updated, skipped }`) stored on the `Generation` trace for observability
- Config flag `extraction: false` on `knowledgeConfig` to opt out per-agent or per-generation
- Tests: extraction triggered on generation complete, not triggered when no memory IDs, extraction result recorded on trace

**Unlocks:** Zero-effort conversational memory — agents accumulate knowledge just by talking, no explicit `write_memory` calls needed.

---

## Overview

The Knowledge module is the **unified retrieval layer** for agents. It searches across all knowledge sources — documents, memory entries, and (in the future) knowledge graphs — and returns ranked, merged results.

The knowledge module does not own any data. It orchestrates queries against data modules (documents, memories) and merges the results into a single ranked list. This decouples agents from the specifics of how knowledge is stored.

The migration from `POST /api/v1/documents/search` to `POST /api/v1/knowledge/search` is **already complete**. The old endpoint and `documentSearch.ts` have been removed. The `documents.ts` module re-exports `mapDocument`, `resolveDocumentSearch`, `DocumentQueryConfig`, and `QueryDocumentResult` from `knowledge.ts` for backward compatibility of internal imports.

## Key Concepts

### Unified Search

A single endpoint accepts a query and optional filters that scope which sources to search:

- **Memory IDs** — search entries within specific memories by ID
- **Memory tags** — search entries in memories matching tag patterns (supports glob: `user*` matches `user`, `user-prefs`, `user-history`)
- **Document paths/IDs** — filter documents by paths or document IDs

If no source filters are provided, the search runs across all accessible documents and memories in the project.

Memory IDs and memory tags can be combined — the search includes entries from memories that match **either** filter (union).

### Source-Tagged Results

Every result includes a `source_type` field so the caller knows where each piece of knowledge came from. Currently only `document` is supported. When memory integration is implemented, `memory` will be added as a second source type.

### Ranking

Results from all sources are ranked by cosine similarity score against the query embedding. Documents and memory entries are interleaved in a single list ordered by score.

## Search Algorithm

```
Input: query (string), project_id, memory_ids[]?, memory_tags[]?, document_paths[]?, document_ids[]?, min_score?, limit?

STEP 1 — EMBED
  Generate embedding for the query.

STEP 2 — RESOLVE MEMORY SCOPE
  Collect target memories from:
    - memory_ids (if provided): memories matching these IDs
    - memory_tags (if provided): memories whose tags match any pattern (glob)
  Union the two sets. If neither is provided, use all memories in the project.

STEP 3 — SEARCH SOURCES (parallel)

  IF target memories is non-empty:
    Search memory entries within resolved memories by cosine similarity.
    Tag each result with source_type = "memory".

  IF document_paths or document_ids is provided (or no filters → all documents in project):
    Search documents by cosine similarity (existing resolveDocumentSearch logic).
    Tag each result with source_type = "document".

STEP 4 — MERGE & RANK
  Combine all results into a single list.
  Sort by score descending.
  Apply min_score filter.
  Apply limit.

STEP 5 — RETURN
  Return the merged, ranked list.
```

## REST API

All body fields use `snake_case` per project convention.

### Search

```
POST /api/v1/knowledge/search
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

```

```

Response:

```json
{
  "results": [
    {
      "source_type": "memory",
      "memory_id": "mem_abc",
      "entry_id": "me_001",
      "content": "Customer prefers email over phone calls, especially for billing inquiries",
      "score": 0.89
    },
    {
      "source_type": "document",
      "document_id": "doc_42",
      "file_id": "fil_07",
      "content": "Communication policy: all billing inquiries should be handled via email...",
      "score": 0.82
    },
    {
      "source_type": "memory",
      "memory_id": "mem_def",
      "entry_id": "me_003",
      "content": "Customer timezone is EST",
      "score": 0.52
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
    "min_score": 0.5,
    "limit": 10
  }
}
```

Simple case (one memory): `{ "knowledge_config": { "memory_ids": ["mem_abc"] } }`

### Three Knowledge Retrieval Paths

| Path                                                             | When                            | Who decides                   | Injected as                      |
| ---------------------------------------------------------------- | ------------------------------- | ----------------------------- | -------------------------------- |
| **Agent config** (`knowledge_config` on agent)                   | Every generation, automatically | Agent creator (at setup time) | System messages                  |
| **Per-generation request** (`knowledge_config` in generate body) | One specific generation         | Caller (at request time)      | System messages                  |
| **Agent self-retrieval**                                         | During generation, dynamically  | The agent (LLM decides)       | Via `search_knowledge` soat-tool |

### Merge Behavior (Agent Config + Per-Generation)

When both are provided, they **append** (not override):

- **Array fields** (`memory_ids`, `memory_tags`, `document_paths`, `document_ids`) → union
- **Scalar fields** (`min_score`, `limit`) → per-generation overrides agent config

```
Agent config:       { memory_ids: ["mem_abc"], limit: 5 }
Per-generation:     { memory_ids: ["mem_xyz"], document_paths: ["/docs/"] }
→ Merged:           { memory_ids: ["mem_abc", "mem_xyz"], document_paths: ["/docs/"], limit: 5 }
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
| `search_knowledge` | Search across memories and documents for relevant knowledge |

This tool replaces the separate `search_documents` tool. The `write_memory` tool stays in the memory module.

## Migration from `documentSearch` (Completed)

The migration is **already done**. This section is kept for historical context.

| Before                          | After (current state)                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `POST /api/v1/documents/search` | Removed — replaced by `POST /api/v1/knowledge/search`        |
| `src/lib/documentSearch.ts`     | Removed — logic lives in `src/lib/knowledge.ts`              |
| `resolveDocumentSearch()`       | Exported from `knowledge.ts` (used by document CRUD routes)  |
| `mapDocument()` (shared mapper) | Exported from `knowledge.ts` (re-exported by `documents.ts`) |
| `search_documents` soat-tool    | Replaced by `searchKnowledge` soat-tool (auto-generated)     |

`documents.ts` re-exports `mapDocument`, `resolveDocumentSearch`, `DocumentQueryConfig`, and `QueryDocumentResult` from `knowledge.ts` so existing internal imports continue to work without changes.

## Implementation Architecture

### Current state (document search only)

```
src/lib/knowledge.ts
├── searchKnowledge()          — public: searches documents, returns KnowledgeResult[]
├── resolveDocumentSearch()    — exported: document vector search with policy/path/id filters
├── mapDocument()              — exported: shared mapper for document CRUD
├── mapRawDocument()           — private: maps DB row + reads file content
├── buildDocWhere()            — private: builds Sequelize where for document IDs
├── buildFileInclude()         — private: builds File include with project/path filters
├── filterByScore()            — private: filters results below min_score
└── types                      — KnowledgeResult, DocumentQueryConfig, QueryDocumentResult
```

### Planned state (after memory integration)

```
src/lib/knowledge.ts
├── searchKnowledge()          — public: unified search orchestrator
├── resolveDocumentSearch()    — exported: existing document search logic
├── searchMemoryEntries()      — private: cosine search against MemoryEntry table
├── mergeAndRank()             — private: combine + sort + filter results
├── mapDocument()              — exported: shared mapper for document CRUD
└── types                      — KnowledgeResult, DocumentQueryConfig, etc.
```

## Permissions

| Permission                  | Endpoint                        |
| --------------------------- | ------------------------------- |
| `knowledge:SearchKnowledge` | `POST /api/v1/knowledge/search` |

The caller must also have read access to the memories and documents being searched. The knowledge module delegates permission checks to the underlying data modules.

## Future: Knowledge Graph

The knowledge module is designed to accommodate additional retrieval strategies:

| Capability       | Status     | Description                                                                 |
| ---------------- | ---------- | --------------------------------------------------------------------------- |
| Document search  | ✅ Done    | Cosine similarity on document embeddings                                    |
| Memory search    | ❌ Planned | Cosine similarity on memory entry embeddings (depends on MemoryEntry model) |
| Knowledge graph  | ❌ Future  | Build and traverse a graph of entities and relationships                    |
| Hybrid retrieval | ❌ Future  | Combine embedding search with graph traversal for richer context            |

When graph retrieval is added, it slots into the same `searchKnowledge` orchestrator as another parallel source, with results merged into the same ranked output.

## Data Model

The knowledge module owns **no tables**. It queries:

- `Document` + `File` (from the documents module) — filtered by paths, tags, document IDs ✅
- `MemoryEntry` (from the memory module) — filtered by `memoryId` ❌ (not yet implemented; depends on MemoryEntry model)

## OpenAPI Spec

The `knowledge.yaml` spec defines one operation:

- `POST /api/v1/knowledge/search` — `searchKnowledge`

The `documents.yaml` spec should be updated to remove (or deprecate) the `POST /api/v1/documents/search` operation.
