# PRD: Memory Module

## Implementation Status

| Component                      | Status         | Notes                                                                                                                |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Memory model (container CRUD)  | ✅ Implemented | Model, lib, REST, OpenAPI, permissions, tests, docs                                                                  |
| Memory tags field              | ✅ Implemented | `tags` string-array column on Memory model; used by `resolveMemorySearch` glob filter                                |
| MemoryEntry model              | ✅ Implemented | Model with `me_` prefix, embedding column, lib, REST, OpenAPI, permissions, tests                                    |
| Entry write (dedup algorithm)  | ✅ Implemented | Two-threshold dedup/merge/skip in `writeMemoryEntry`; `mergeEntryContent` concatenates existing and incoming content |
| Entry REST endpoints           | ✅ Implemented | `POST/GET/PUT/DELETE /api/v1/memories/:memoryId/entries`; POST returns `action` field                                |
| Entry permissions              | ✅ Implemented | `WriteMemoryEntry`, `ReadMemoryEntry`, `ListMemoryEntries`, `UpdateMemoryEntry`, `DeleteMemoryEntry`                 |
| `knowledgeConfig` on Agent     | ✅ Implemented | JSONB field on Agent model; merged with per-generation config; drives automatic context injection                    |
| Extraction (post-conversation) | ❌ Not started | Auto-extract facts from conversation turns                                                                           |
| write_memory soat-tool         | ❌ Not started | Agent tool for writing to a memory                                                                                   |
| Knowledge integration          | ✅ Implemented | `resolveMemorySearch()` in `knowledge.ts`; `memoryIds`/`memoryTags` in `searchKnowledge()`                           |

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

### Phase 2 — Agent Read & Write ✅ Partially complete

**Goal:** Make agents memory-aware. Agents can recall facts before generating and write new facts during generation. This is the minimum needed for a compelling AI app tutorial.

**Deliverables:**

- ✅ **Memory source in `searchKnowledge()`** — `memoryIds` and `memoryTags` parameters added; `resolveMemorySearch()` queries MemoryEntry embeddings; results interleaved by score; `source_type: "memory"` in `KnowledgeResult`
- ✅ **`document_paths` and `document_ids` parameters** — flat fields in OpenAPI spec and lib (replacing nested `document_filters`)
- ✅ **`knowledge_config` on Agent** — JSONB field on `agents` table; merged with per-generation `knowledge_config` using append semantics; drives automatic context injection via `buildKnowledgeMessages()` in `agentKnowledge.ts`
- ✅ **Automatic context injection** — `buildKnowledgeMessages()` called in `agentGeneration.ts` before each generation; results injected as system messages
- ❌ **`write_memory` soat-tool** — agent tool that calls `writeMemoryEntry()` with `{ content, memoryId }`; not yet implemented
- ✅ OpenAPI spec updated, SDK/CLI regenerated, tests added

**Unlocks:** Agents that remember and recall. First tutorial: "Build an agent with persistent memory."

---

### Phase 3 — Memory Tags & Filtering ❌ Not started

**Goal:** Enable memory organisation at scale — multiple memories per project, filtered by tag patterns.

**Deliverables:**

- `tags` column (string array) on the `Memory` model
- Tag filter on `GET /api/v1/memories` (exact and glob match)
- `memory_tags` glob matching in `searchKnowledge()` — e.g., `user*` matches `user`, `user-prefs`, `user-history`
- Update OpenAPI spec, permissions page, module docs

**Unlocks:** Multi-memory projects. Agents scoped to tag-matched memories without knowing IDs upfront.

---

### Phase 4 — Automatic Extraction ❌ Not started

**Goal:** Agents learn passively. Facts are extracted from conversations automatically — no explicit `write_memory` call needed.

**Deliverables:**

- Post-generation extraction pipeline (fire-and-forget, non-blocking)
- LLM prompt to extract atomic facts from completed conversation turn
- Each candidate runs through the standard `writeMemoryEntry()` write algorithm
- Extraction triggered when an agent's `knowledge_config` includes `memory_ids` with `extraction: true`
- Return summary `{ created, updated, skipped }` in the generation trace
- Tests covering extraction trigger, candidate extraction, dedup during extraction

**Unlocks:** Zero-effort conversational memory — agents accumulate knowledge just by talking.

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

During a generation, an agent can call the `write_memory` tool with `{ "content": "...", "memoryId": "mem_..." }`. The write algorithm runs identically.

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

Extraction is triggered when an agent or chat with attached memories completes a generation.

## Agent Integration

### Knowledge Config

Instead of a separate join table, the Agent model stores a `knowledgeConfig` JSONB field that mirrors the `searchKnowledge` parameters. This is simpler — one field on the agent instead of a separate table and attachment endpoints.

```json
PUT /api/v1/agents/{agent_id}
{
  "knowledge_config": {
    "memory_ids": ["mem_abc", "mem_def"],
    "memory_tags": ["crm", "user*"],
    "document_paths": ["/sales/"],
    "document_ids": ["doc_01"],
    "min_score": 0.5,
    "limit": 10
  }
}
```

**Simple case** — agent needs just one memory:

```json
{ "knowledge_config": { "memory_ids": ["mem_abc"] } }
```

**Rich case** — agent needs memories + scoped documents:

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_abc"],
    "memory_tags": ["projectA"],
    "document_paths": ["/docs/"],
    "limit": 20
  }
}
```

**No knowledge** — omit `knowledge_config` or set to `null`.

### Three Knowledge Retrieval Paths

There are three ways to provide knowledge to an agent:

| Path                                                             | When                            | Who decides                   | Injected as                      |
| ---------------------------------------------------------------- | ------------------------------- | ----------------------------- | -------------------------------- |
| **Agent config** (`knowledge_config` on agent)                   | Every generation, automatically | Agent creator (at setup time) | System messages                  |
| **Per-generation request** (`knowledge_config` in generate body) | One specific generation         | Caller (at request time)      | System messages                  |
| **Agent self-retrieval**                                         | During generation, dynamically  | The agent (LLM decides)       | Via `search_knowledge` soat-tool |

### Merge Behavior (Agent Config + Per-Generation)

When both the agent's stored `knowledge_config` and a per-generation `knowledge_config` are provided, they are **appended** (not overridden):

- **Array fields** (`memory_ids`, `memory_tags`, `document_paths`, `document_ids`) → union of both sets
- **Scalar fields** (`min_score`, `limit`) → per-generation overrides agent config

Example:

```
Agent config:       { memory_ids: ["mem_abc"], limit: 5 }
Per-generation:     { memory_ids: ["mem_xyz"], document_paths: ["/docs/"] }

→ Merged:           { memory_ids: ["mem_abc", "mem_xyz"], document_paths: ["/docs/"], limit: 5 }
```

Both sets of results are injected as **system messages**, ordered by score.

### Generation Flow

1. **Merge configs** — combine agent's stored `knowledgeConfig` with per-generation `knowledgeConfig` (if provided) using append semantics.
2. **Search** — call `searchKnowledge()` with the merged config filters and the conversation context as the query.
3. **Inject** — prepend results as system messages, tagged by source.
4. **Generate** — send to LLM with instructions + knowledge + conversation.
5. **Post-generate (async)** — if the merged config includes `memory_ids`, the extraction algorithm runs on the completed conversation turn, writing new facts to those memories.

### Agent Memory Tools (soat-tools)

When an agent has a `knowledgeConfig` with memory IDs, it gains access to these tools:

| Tool               | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `write_memory`     | Write content to a memory (system decides: create, merge, or skip)   |
| `search_knowledge` | Search across memories and documents (delegated to knowledge module) |

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
| embedding | VECTOR(1536) | NOT NULL                       |
| createdAt | TIMESTAMP    | NOT NULL                       |
| updatedAt | TIMESTAMP    | NOT NULL                       |

**Indexes:**

- `UNIQUE (publicId)` on both tables
- `(memoryId)` — for listing entries within a memory
- `HNSW (embedding)` — for cosine similarity search

### Agent `knowledgeConfig` Field

Stored as JSONB on the `agents` table. Schema:

```ts
interface KnowledgeConfig {
  memoryIds?: string[]; // mem_... IDs to search
  memoryTags?: string[]; // glob patterns to match memory tags
  documentPaths?: string[]; // file path prefixes
  documentIds?: string[]; // doc_... IDs
  minScore?: number; // minimum cosine similarity (0–1)
  limit?: number; // max results to inject
}
```

No join table needed. The agent stores its knowledge retrieval config inline.

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

### Agent Knowledge Config

No separate endpoints — use the standard agent update endpoint:

| Method | Path                      | Description                               |
| ------ | ------------------------- | ----------------------------------------- |
| PUT    | `/api/v1/agents/:agentId` | Update agent including `knowledge_config` |
