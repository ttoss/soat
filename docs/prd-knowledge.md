# PRD: Knowledge Module

## Overview

The Knowledge module is the **unified retrieval layer** for agents. It searches across all knowledge sources — documents, memory entries, and (in the future) knowledge graphs — and returns ranked, merged results.

The knowledge module does not own any data. It orchestrates queries against data modules (documents, memories) and merges the results into a single ranked list. This decouples agents from the specifics of how knowledge is stored.

This module replaces the existing `POST /api/v1/documents/search` endpoint with a broader `POST /api/v1/knowledge/search` that can query documents, memories, or both in a single call.

## Key Concepts

### Unified Search

A single endpoint accepts a query and optional filters that scope which sources to search:

- **Memory IDs** — search entries within specific memories
- **Document filters** — filter documents by paths, tags, or document IDs

If no filters are provided, the search runs across all accessible documents and memories in the project.

### Source-Tagged Results

Every result includes a `source_type` field (`document` or `memory`) and the relevant source IDs, so the caller knows where each piece of knowledge came from.

### Ranking

Results from all sources are ranked by cosine similarity score against the query embedding. Documents and memory entries are interleaved in a single list ordered by score.

## Search Algorithm

```
Input: query (string), project_id, memory_ids[]?, document_filters?, min_score?, limit?

STEP 1 — EMBED
  Generate embedding for the query.

STEP 2 — SEARCH SOURCES (parallel)

  IF memory_ids is provided (or no filters → all memories in project):
    Search memory entries by cosine similarity.
    Tag each result with source_type = "memory".

  IF document_filters is provided (or no filters → all documents in project):
    Search documents by cosine similarity (existing resolveDocumentSearch logic).
    Tag each result with source_type = "document".

STEP 3 — MERGE & RANK
  Combine all results into a single list.
  Sort by score descending.
  Apply min_score filter.
  Apply limit.

STEP 4 — RETURN
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
  "document_filters": {
    "paths": ["/sales/"],
    "document_ids": ["doc_01"],
    "tags": { "department": "sales" }
  },
  "min_score": 0.5,
  "limit": 10
}
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

### Context Assembly

When an agent generates a response, the knowledge module is the single entry point for retrieving context:

1. Determine which memories are attached to the agent.
2. Call `searchKnowledge` with the conversation context as the query, scoped to the agent's attached memories and project documents.
3. Inject the top results as system messages, tagged by source:

```
[Memory: Customer Preferences] Customer prefers email over phone calls
[Document: /sales/comm-policy.md] Communication policy: all billing inquiries should be handled via email...
```

### soat-tools

| Tool               | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| `search_knowledge` | Search across memories and documents for relevant knowledge |

This tool replaces the separate `search_documents` tool. The `write_memory` tool stays in the memory module.

## Migration from `documentSearch`

### What Changes

| Before                          | After                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `POST /api/v1/documents/search` | `POST /api/v1/knowledge/search`                              |
| `src/lib/documentSearch.ts`     | `src/lib/knowledge.ts`                                       |
| `resolveDocumentSearch()`       | Private helper inside `knowledge.ts`                         |
| `mapDocument()` (shared mapper) | Stays exported from `knowledge.ts` (documents CRUD needs it) |
| `search_documents` soat-tool    | `search_knowledge` soat-tool                                 |

### What Stays the Same

- Document CRUD endpoints (`POST/GET/PUT/DELETE /api/v1/documents`) are unchanged — they remain in the documents module.
- The existing `resolveDocumentSearch` logic is preserved as an internal function inside `knowledge.ts`.
- `mapDocument` remains exported for document CRUD routes.

### Backwards Compatibility

The old `POST /api/v1/documents/search` endpoint should be kept temporarily as a deprecated alias that delegates to the knowledge module with `document_filters` only (no memory search). This can be removed in a future version.

## Implementation Architecture

```
src/lib/knowledge.ts
├── searchKnowledge()          — public: unified search orchestrator
├── searchDocuments()          — private: existing resolveDocumentSearch logic
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

| Capability       | Status | Description                                                      |
| ---------------- | ------ | ---------------------------------------------------------------- |
| Document search  | Now    | Cosine similarity on document embeddings                         |
| Memory search    | Now    | Cosine similarity on memory entry embeddings                     |
| Knowledge graph  | Future | Build and traverse a graph of entities and relationships         |
| Hybrid retrieval | Future | Combine embedding search with graph traversal for richer context |

When graph retrieval is added, it slots into the same `searchKnowledge` orchestrator as another parallel source, with results merged into the same ranked output.

## Data Model

The knowledge module owns **no tables**. It queries:

- `MemoryEntry` (from the memory module) — filtered by `memoryId`
- `Document` + `File` (from the documents module) — filtered by paths, tags, document IDs

## OpenAPI Spec

The `knowledge.yaml` spec defines one operation:

- `POST /api/v1/knowledge/search` — `searchKnowledge`

The `documents.yaml` spec should be updated to remove (or deprecate) the `POST /api/v1/documents/search` operation.
