# PRD: Memory Module

## Implementation Status

| Component                      | Status         | Notes                                                                                                                            |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Memory model (container CRUD)  | ✅ Implemented | Model, lib, REST, OpenAPI, permissions, tests, docs                                                                              |
| Memory tags field              | ✅ Implemented | `tags` string-array column on Memory model; glob filter on `GET /memories`; `resolveMemoryIdsByGlobTags()` in knowledge search   |
| MemoryEntry model              | ✅ Implemented | Model with `me_` prefix, embedding column, lib, REST, OpenAPI, permissions, tests                                                |
| Entry write (dedup algorithm)  | ✅ Implemented | Two-threshold dedup/merge/skip in `writeMemoryEntry`; v1 merge (`mergeEntryContent`) concatenates — superseded by Phase 5 (v2)   |
| Entry REST endpoints           | ✅ Implemented | `POST/GET/PUT/DELETE /api/v1/memories/:memoryId/entries`; POST returns `action` field                                            |
| Entry permissions              | ✅ Implemented | `WriteMemoryEntry`, `ReadMemoryEntry`, `ListMemoryEntries`, `UpdateMemoryEntry`, `DeleteMemoryEntry`                             |
| `knowledgeConfig` on Agent     | ✅ Implemented | JSONB field on Agent model; merged with per-generation config; drives automatic context injection                                |
| Extraction (post-conversation) | ✅ Implemented | `runMemoryExtraction()` in `memoryExtraction.ts`; opt-in via `knowledge_config.extraction: true` + `write_memory_id`; summary on generation `metadata.extraction` |
| Knowledge integration          | ✅ Implemented | `resolveMemorySearch()` in `knowledgeMemory.ts`; `memoryIds`/`memoryTags` in `searchKnowledge()`                                 |
| Write algorithm v2 (arbitrated)| ❌ Not started | Top-K shortlist + LLM decision (add/update/supersede/skip); real merge replaces the v1 concatenation shortcut (Phase 5)          |
| Temporal invalidation          | ❌ Not started | `invalidatedAt` + `supersededByEntryId` on MemoryEntry; contradictions retire old facts instead of rewriting them (Phase 5)      |
| Entry provenance               | ❌ Not started | `sourceGenerationId` / `sourceConversationId` on MemoryEntry; every fact auditable back to its source turn (Phase 5)             |
| MemoryEntity model             | ❌ Not started | Project-scoped extracted nouns/objects with `mey_` prefix, embedding column, optional `actorId` FK; deduplicated across memories (Phase 6) |
| MemoryEntityEdge model         | ❌ Not started | First-class entity→entity edges: subject, canonical predicate, object, provenance entry, validity (Phase 6)                      |
| Entity extraction on write     | ❌ Not started | Async, off the request path; LLM extracts subject/predicate/object triples after the entry persists (Phase 6)                    |
| Entity-based knowledge queries | ❌ Not started | Memory-side `resolveEntitySearch()` (entity/actor → edges → entries). Query surface specced in prd-knowledge.md Phase 3 (Phase 6) |
| Streaming extraction coverage  | ❌ Not started | Extraction trigger for streaming and `requires_action` completions (Phase 7)                                                     |
| Decay, importance & compaction | ❌ Not started | Importance scoring, access tracking, retrieval-time recency blend, compaction (Phase 8)                                          |
| Profile memory                 | ❌ Not started | Always-injected bounded profile blocks, agent-editable (Phase 9)                                                                 |

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

**Not triggered for:** streaming generations and `requires_action` (client-tool) turns — the turn must complete in the same request. This is a significant coverage gap in practice (streaming is the default transport in production chat UIs); extending coverage to these turn types is Phase 7.

**Unlocks:** Zero-effort conversational memory — agents accumulate knowledge just by talking.

---

### Phase 5 — Write Algorithm v2 (LLM-Arbitrated, Temporal) ❌ Not started

**Goal:** Replace the v1 threshold-decided, concatenation-merge write path with an LLM-arbitrated
decision over a shortlist of similar entries; add temporal invalidation (supersede) so
contradictions retire old facts instead of rewriting them; and record provenance so every entry is
auditable back to the conversation that produced it.

**Motivation:** v1 has three structural problems (see
[Known v1 Limitations](#known-v1-limitations-addressed-by-phase-5)): the concatenation merge
destroys entry atomicity, contradictions are appended or silently coexist, and fixed cosine
thresholds both make the decision and fail to port across embedding models. State-of-the-art
memory pipelines (Mem0's add/update/delete/no-op arbitration, Zep/Graphiti's temporal fact
invalidation) use embeddings only to shortlist candidates, let an LLM choose the operation, and
never silently destroy superseded knowledge — they timestamp it out of validity.

#### 5a — LLM-arbitrated write decision

```
Input: content (string), memory_id

STEP 1 — EMBED (best-effort, unchanged from v1)

STEP 2 — SHORTLIST
  Retrieve the top-K (default 5) existing valid entries by cosine similarity.
  If topMatch.score ≥ duplicate_threshold (default 0.95) → SKIP (no LLM call).
  Drop candidates below shortlist_threshold (default 0.60).
  If the shortlist is empty → CREATE (no LLM call).

STEP 3 — ARBITRATE (LLM)
  Given the incoming fact and the shortlisted existing facts, the model picks:
    - add           → genuinely new knowledge
    - update(id)    → refines an existing entry; returns ONE consolidated
                      atomic fact (not a concatenation)
    - supersede(id) → contradicts an existing entry; returns the replacement
    - skip          → already known

  Output: { operation, target_entry_id?, content? }

STEP 4 — APPLY
  add       → create entry
  update    → rewrite target content with the consolidated fact, re-embed
  supersede → create the replacement entry; set target.invalidatedAt = now and
              target.supersededByEntryId = replacement
  skip      → no-op

STEP 5 — RETURN { action: "created" | "updated" | "superseded" | "skipped", entry }
```

- Arbitration runs on a configurable provider/model (same override shape as extraction) so a cheap
  model can be used; the decision considers **multiple** candidates, not just the top-1 match.
- **Fallback:** if the arbitration call fails, fall back to v1 semantics (skip on ≥ 0.95, create
  otherwise) — a failed LLM call must never lose a write.
- Thresholds change roles: `duplicate_threshold` short-circuits exact duplicates,
  `shortlist_threshold` bounds the candidate set, and the cosine score no longer decides
  create-vs-update.

#### 5b — Temporal invalidation (supersede)

- New `MemoryEntry` columns: `invalidatedAt` (timestamp; `null` = currently valid) and
  `supersededByEntryId` (FK → MemoryEntry).
- Invalidated entries are excluded from knowledge search, extraction dedup, and the arbitration
  shortlist by default; entry listing gains `include_invalidated` for audit.
- Nothing is silently destroyed: supersede preserves the full history chain
  (old entry → `supersededByEntryId` → replacement). `DELETE` remains available for hard removal.

#### 5c — Provenance

- New `MemoryEntry` columns: `sourceGenerationId` and `sourceConversationId` (nullable FKs),
  populated by the `write_memory` tool and extraction write paths; exposed as
  `source_generation_id` / `source_conversation_id`.
- Answers "why does the agent believe this" — every agent/extraction fact links back to the turn
  that produced it, pairing with the extraction summary already stored on
  `generation.metadata.extraction`.
- Ships early on purpose: provenance cannot be backfilled once entries exist.

**Unlocks:** Trustworthy memory. Contradictions resolve instead of accumulating, merged facts stay
atomic, superseded knowledge remains auditable, and every fact traces to its source conversation.

---

### Phase 6 — Entity Graph Layer ❌ Not started

**Goal:** Extract structured entities and relationships from memory entries so knowledge can be queried by graph traversal — not just vector similarity. Enables precise queries like "everything about Pedro" or "what does Company X own?" without relying on embedding proximity.

**Motivation:** Vector search excels at semantic similarity ("find things related to billing") but is weak for structural/relational queries. A memory entry "Pedro owns Company X" embeds as a single vector — querying for "Pedro" may not surface it if the embedding space doesn't place it close enough. An entity graph layer decomposes entries into queryable nodes (entities) and edges (relationships), enabling exact lookups and traversals.

| Query type                              | Vector search                                         | Entity graph                          |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| "What do we know about billing?"        | ✅ Good                                               | ⚠️ Requires entity indexing           |
| "What does Pedro own?"                  | ⚠️ Fuzzy — returns anything _similar_ to "Pedro owns" | ✅ Exact — traverse Pedro → owns → \* |
| "All entities connected to Company X"   | ❌ Poor                                               | ✅ Direct graph traversal             |
| "All memories involving actor `act_01`" | ❌ Impossible without metadata                        | ✅ Direct FK lookup                   |

**Deliverables:**

#### 6a — MemoryEntity + MemoryEntityEdge models

- `MemoryEntity` model (`mey_` prefix) — **project-scoped**, deduplicated nouns/objects extracted from entries, with optional `actorId` FK for entities that correspond to known actors
- Entities live at **project level**, not memory level — enabling cross-memory graph traversal ("find everything about Pedro across all memories")
- `MemoryEntityEdge` model — a first-class **entity → entity** edge: `{ subjectEntityId, predicate, objectEntityId, entryId, invalidatedAt }`. The entry is the edge's **provenance** (which fact asserted it), not a party to it. This keeps triples unambiguous: "Pedro owns Company X and Maria owns Company Y" in one entry produces two edges whose subject/object pairing is explicit — an entry↔entity join table would produce four same-verb mention rows that cannot be re-paired into triples
- **Canonical predicates** — extraction normalizes verbs to a canonical snake_case predicate before storage (`"is the owner of"` → `owns`). Free-form labels fragment the graph and make `predicate` filters miss; the predicate set is open, but normalization is mandatory
- **Edge validity** — edges carry `invalidatedAt`; when an entry is superseded (Phase 5b) or deleted, the edges it asserted are invalidated/removed with it
- CRUD endpoints for entities: `GET/PUT/DELETE /api/v1/entities` (project-scoped, not nested under memories), plus `GET /api/v1/entities/:entityId/edges`
- Entity deduplication by embedding similarity within a project (same two-threshold pattern as entries)

#### 6b — Async entity extraction on write

- When `writeMemoryEntry()` creates or updates an entry, run a lightweight LLM extraction to decompose content into `[{ subject, predicate, object }]` triples
- Upsert entities by name within the **project** (deduplicate by embedding similarity); create edges with canonical predicates and the entry as provenance
- **Asynchronous, best-effort:** extraction runs **off the request path** (fire-and-forget after the entry is persisted, the same pattern as memory extraction) so write latency is never LLM-bound. If it fails, the entry still exists — entities are an enrichment, not a critical path
- Entity extraction from a single atomic entry is cheap (~500ms LLM call), unlike Phase 4's conversation-level extraction — but still too slow to sit inside a REST write

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
  2. Write decision → create/update/supersede/skip (v1 thresholds today;
     LLM arbitration after Phase 5)
  3. If created or updated:
     a. Persist entry to DB
     b. Enqueue (fire-and-forget, best-effort): extract entities + upsert + link
        Prompt: "Extract entities and relationships from: <content>"
        → [{ subject: string, predicate: string, object: string }]
        On UPDATE or supersede: invalidate this entry's existing edges first —
        the new content may assert different relationships, so stale edges must
        not survive. (Orphaned entities are pruned separately, not here.)
        For each triple:
          - Upsert subject entity (deduplicate by embedding within project)
          - Upsert object entity (deduplicate by embedding within project)
          - Normalize the predicate to canonical snake_case
          - Create a MemoryEntityEdge { subject, predicate, object, entryId }
        On failure: log warning — entry exists, edges don't
  4. Return { action, entry }   # never blocked on entity extraction
```

#### 6c — Entity-based knowledge queries

The **query surface** for entity-based search (the `entity_ids`, `entity_names`, `actor_ids`,
`entity_types`, `predicate`, and `direction` parameters; query modes; ranking) is owned by
the knowledge module — see [prd-knowledge.md Phase 3 — Entity Graph Queries](./prd-knowledge.md#phase-3--entity-graph-queries--future).
This phase delivers the **memory-side data layer** that Phase 3 queries against:

- `resolveEntitySearch()` resolves entities by ID / name / actor / type, follows their
  `MemoryEntityEdge` edges (applying `predicate` / `direction` filters), and maps matched edges
  to their provenance entries.
- Entity filters narrow the candidate set; when a `query` is present, vector search ranks within it.
- Memory-type results are enriched with their linked entities (see [Entity Graph (Edges)](#entity-graph-edges)).
- **Single-hop only:** entity → edges → entries. Multi-hop path traversal ("how are Pedro and
  Company X related?") is out of scope until a dedicated path-query design exists.

**Unlocks:** Precise, structured knowledge retrieval. Agents can answer "what do we know about this customer?" with exact graph queries instead of hoping vector similarity surfaces the right entries.

---

### Phase 7 — Extraction Coverage (Streaming and Client-Tool Turns) ❌ Not started

**Goal:** Fire memory extraction for the turn types that skip it today. Streaming is the default
transport in production chat UIs, so the passive-memory pipeline currently misses most real
traffic.

**Deliverables:**

- Trigger extraction when a **streaming** generation completes — fire-and-forget after the final
  chunk is flushed, using the fully accumulated transcript
- Trigger extraction when a `requires_action` (client-tool) turn reaches its terminal `completed`
  state via `tool-outputs` — once per logical turn, not per round-trip
- Idempotency guard: at most one extraction per generation (`metadata.extraction` is the marker),
  so retries and multi-request turns cannot double-write
- Same opt-in condition (`extraction` + `write_memory_id`) and summary reporting as Phase 4

**Unlocks:** Passive memory that covers production traffic, not just non-streaming API calls.

---

### Phase 8 — Forgetting (Decay, Importance, Compaction) ❌ Not started

**Goal:** Keep memories healthy as they grow. An append-mostly store with no forgetting degrades —
retrieval fills with stale, trivial, or redundant facts. State-of-the-art agent memory scores
entries by recency × importance × relevance (the Generative Agents formula) and compacts
periodically.

**Deliverables:**

- `importance` (0–1) on `MemoryEntry`, assigned at write time by the arbitration/extraction LLM
  ("how durable and consequential is this fact?"); `null` (neutral) for manual writes unless
  provided
- `lastAccessedAt` + `accessCount` on `MemoryEntry`, updated fire-and-forget when an entry is
  returned by knowledge search
- Retrieval-time scoring blend for memory results — similarity × recency decay × importance —
  owned by the knowledge module's ranking layer (see
  [prd-knowledge.md Phase 5](./prd-knowledge.md#phase-5--hybrid-retrieval-and-ranking--future))
- Optional per-memory retention policy: `max_entries` and/or `ttl_days` on the Memory container;
  eviction prefers invalidated, low-importance, least-recently-accessed entries first
- Compaction: `POST /api/v1/memories/:memoryId/compact` clusters near-duplicate valid entries and
  merges each cluster through the v2 arbitration path (manual/scheduled trigger; never automatic
  inside a write)

**Unlocks:** Memories that stay useful at 10,000 entries, not just at 100.

---

### Phase 9 — Profile Memory (Always-Injected Blocks) ❌ Not started

**Goal:** Add the second memory kind production assistants need: a small, bounded **profile**
that is always in context, alongside the existing retrieved fact store. Top-k retrieval is
probabilistic; for durable, high-value context ("customer is Pedro, prefers email, timezone EST")
the state of the art (Letta/MemGPT core memory blocks, ChatGPT's user profile) keeps a compact
block always injected and lets the agent edit it.

**Sketch (to be refined before implementation):**

- `type` on the Memory container: `facts` (default — current behavior) | `profile`
- A profile memory holds a single bounded content block (e.g. 2–4 KB) instead of entries; it is
  injected **in full** for agents whose `knowledge_config` references it — no vector retrieval
- `update_profile` soat-tool (rewrite-in-place semantics), bound via `knowledge_config` the same
  way `write_memory` is
- Extraction variant: consolidate turn facts **into** the profile block (rewrite) rather than
  appending entries

**Out of scope for now:** procedural memory (learned instructions/skills) — a future direction
once profile memory validates the always-injected path.

---

## Overview

The Memory module provides a project-scoped mechanism for storing and retrieving knowledge. A **memory** is a named container that accumulates atomic facts (entries) via a deduplication and merge algorithm.

A project can have **many memories**, each representing a different knowledge domain (e.g., "Customer Preferences", "Project Context", "Technical Decisions"). Entries written to a memory are automatically deduplicated within that memory's scope.

Searching across memories and documents is handled by the **knowledge module** (`POST /api/v1/knowledge/search`). The memory module owns storage and write logic only — it does not expose its own search endpoint.

This module resolves two roadmap items:

- **Agent Memory (P2)** — persistent, project-scoped knowledge for agents
- **Conversational Memory** — auto-extract facts from conversations

Memory quality is evaluated through the knowledge module's evaluation harness (write correctness,
contradiction handling, long-horizon recall) — see
[prd-knowledge.md Phase 7](./prd-knowledge.md#phase-7--evaluation-harness-and-observability--future).

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
| `source_generation_id`   | string   | auto | Generation that produced this entry (agent/extraction writes) — *Phase 5*  |
| `source_conversation_id` | string   | auto | Conversation the entry was extracted from — *Phase 5*                      |
| `invalidated_at`         | datetime | auto | When this entry was superseded; `null` = currently valid — *Phase 5*       |
| `superseded_by_entry_id` | string   | auto | The entry that replaced this one — *Phase 5*                               |
| `importance`             | number   | auto | Write-time durability score used in retrieval ranking — *Phase 8*          |

**Source types:**

- `manual` — created by a user via the REST API
- `agent` — created by an agent via the `write_memory` soat-tool during a generation
- `extraction` — created by the automatic extraction system after a conversation turn

**Design principles:**

- Entries are **atomic** — one fact per entry (e.g., "Customer prefers email communication", not a paragraph mixing multiple facts).
- Entries are **memory-scoped** — deduplication runs within a single memory's entries. Different memories can hold related facts independently.
- Entries are **automatically deduplicated** — the write algorithm prevents duplicate and near-duplicate entries within a memory.
- Entries are **mutable** — they can be merged with new information or manually updated.
- Entries are **embedded (best-effort)** — each entry gets an embedding vector computed from its content for semantic search. Embedding is non-fatal: if the embedding provider is unavailable, the entry is still stored with a `null` embedding (and dedup is skipped for that write). The column is nullable, mirroring `DocumentChunk.embedding`. A null-embedding entry is not returned by semantic search until it is re-embedded (e.g. via a content update).
- Entries are **temporal** *(Phase 5)* — a contradicted entry is superseded (`invalidated_at` set, `superseded_by_entry_id` pointing at its replacement), not silently rewritten or destroyed; search only sees currently-valid entries by default.
- Entries are **auditable** *(Phase 5)* — agent- and extraction-written entries link back to the generation and conversation that produced them.

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

### Entity Graph (Edges)

Relationships are modeled as first-class **entity → entity edges**. An edge is a directed triple —
subject entity, canonical predicate, object entity — with the memory entry that asserted it as
provenance:

| Field               | Type     | Description                                                |
| ------------------- | -------- | ---------------------------------------------------------- |
| `subject_entity_id` | FK       | The entity doing the action                                |
| `predicate`         | string   | Canonical snake_case verb (`owns`, `works_at`, `prefers`)  |
| `object_entity_id`  | FK       | The entity receiving the action                            |
| `entry_id`          | FK       | The memory entry that asserted this edge (provenance)      |
| `invalidated_at`    | datetime | Set when the asserting entry is superseded; `null` = valid |

**Example:** Entry "Pedro owns Company X" produces:

```
Entity: { name: "Pedro", entity_type: "person", actor_id: "act_01" }   # project-scoped
Entity: { name: "Company X", entity_type: "organization" }              # project-scoped

Edge: { subject: mey_pedro, predicate: "owns", object: mey_companyX, entry: me_001 }
```

Edges connect entities to entities (with the entry as provenance) rather than linking entries to
entities with a label. This keeps triples unambiguous: "Pedro owns Company X and Maria owns
Company Y" yields two edges whose subject/object pairing is explicit, where four entry↔entity
mention rows sharing the same verb could not be re-paired into triples.

This enables queries like:

- "All entries about Pedro" → match entity by name → its edges → provenance entries (from **any** memory in the project)
- "What does Pedro own?" → edges where subject = Pedro and predicate = `owns` → objects + entries
- "All entries involving actor `act_01`" → entity with that `actor_id` → its edges → entries
- Multi-hop path traversal ("how are Pedro and Company X related?") is a **future extension** — the initial query surface is single-hop (see prd-knowledge.md Phase 3)

### Relationship to Documents and Knowledge

Memories and documents are independent storage systems. The **knowledge module** provides a unified search layer across both.

| Concern            | Memories                           | Documents                         | Knowledge                            |
| ------------------ | ---------------------------------- | --------------------------------- | ------------------------------------ |
| What it stores     | Atomic facts (1–2 sentences)       | Full content (files, pages, etc.) | Nothing — query orchestrator only    |
| How content enters | Write algorithm (dedup/merge/skip) | Upload or create                  | —                                    |
| Search endpoint    | —                                  | —                                 | `POST /api/v1/knowledge/search`      |
| Managed by         | System (automatic dedup)           | User (manual upload)              | System (unified retrieval + ranking) |

See the [Knowledge Module PRD](./prd-knowledge.md) for details.

## Write Algorithm (v1 — implemented)

Every write to a memory — manual, agent, or extraction — goes through the same algorithm. The caller provides `content` and the system determines the outcome. Dedup is scoped to the target memory.

> **v1 status.** The algorithm below describes the **implemented** behavior, including its known
> shortcut: the merge step **concatenates** contents instead of consolidating them with an LLM.
> [Phase 5](#phase-5--write-algorithm-v2-llm-arbitrated-temporal--not-started) replaces the
> decision and merge steps with an LLM-arbitrated operation (add / update / supersede / skip).

```
Input: content (string), memory_id

STEP 1 — EMBED (best-effort)
  Generate embedding for the content.
  If embedding fails, continue with a null embedding: skip STEP 2/3 dedup
  and create the entry directly (non-fatal, mirrors document chunk ingestion).

STEP 2 — SEARCH
  Search existing entries in this memory by cosine similarity.
  Let topMatch = highest-similarity existing entry.

STEP 3 — DECIDE

  CASE 1: topMatch.score ≥ DUPLICATE_THRESHOLD (default 0.95)
    → SKIP. The fact is already known.
    Return { action: "skipped", entry: topMatch }

  CASE 2: topMatch.score ≥ UPDATE_THRESHOLD (default 0.75)
    → MERGE. The fact overlaps with existing knowledge.
    v1 (implemented): merged = existing + "\n" + incoming   (concatenation)
    v2 (Phase 5):     an LLM produces a single consolidated atomic fact and
                      can supersede on contradiction
    Update topMatch: content = merged, re-generate embedding, update updated_at.
    Return { action: "updated", entry: topMatch }

  CASE 3: topMatch.score < UPDATE_THRESHOLD (or no existing entries)
    → CREATE. This is genuinely new knowledge.
    Create a new entry with the provided content and embedding.
    Return { action: "created", entry: newEntry }
```

### Why Two Thresholds

The two-threshold approach handles three scenarios cleanly:

- **High similarity (≥ 0.95):** "The user likes Python" vs "User prefers Python" → same fact, skip.
- **Medium similarity (0.75–0.95):** "The user likes Python" vs "The user likes Python 3.12 specifically" → related, merge into a richer fact.
- **Low similarity (< 0.75):** "The user likes Python" vs "The project deadline is Friday" → unrelated, create new entry.

### Known v1 Limitations (addressed by Phase 5)

- **Concatenation merge breaks atomicity.** Repeated merges turn a one-fact entry into a
  multi-fact paragraph, its embedding drifts away from any single fact it contains, and the
  entity extraction in Phase 6 receives multi-fact content. An LLM consolidation step is required
  to keep entries atomic.
- **No contradiction resolution.** Concatenation appends conflicting statements; worse, a
  contradicting fact phrased differently can score below the update threshold and simply coexist
  ("Pedro works at Company X" / "Pedro left Company X"). There is no delete/invalidate operation —
  state-of-the-art pipelines (e.g. Mem0) arbitrate add / update / delete / no-op per write.
- **Top-1 comparison only.** A new fact can overlap several existing entries; v1 considers only
  the single best match.
- **Thresholds are embedding-model-coupled.** Cosine cutoffs are not portable across embedding
  models. v2 keeps thresholds only to shortlist candidates and short-circuit exact duplicates —
  the operation decision moves to an LLM.

### Threshold Configuration

Thresholds can be overridden per request via optional fields in the write endpoint body:

| Field                 | Type   | Default | Description                               |
| --------------------- | ------ | ------- | ----------------------------------------- |
| `duplicate_threshold` | number | 0.95    | Similarity above which content is skipped |
| `update_threshold`    | number | 0.75    | Similarity above which content merges     |

In write algorithm v2 (Phase 5) these thresholds stop deciding the outcome: `duplicate_threshold`
still short-circuits near-exact duplicates, a new `shortlist_threshold` (default 0.60) bounds the
arbitration candidate set, and the create/update/supersede decision moves to an LLM.

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

→ { "action": "updated", "entry": { "id": "me_001", "content": "Customer prefers email over phone calls\nCustomer prefers email, especially for billing inquiries", ... } }
```

> v1 concatenates on merge (shown above). With write algorithm v2 (Phase 5) the LLM consolidates
> instead: `"Customer prefers email over phone calls, especially for billing inquiries"`.

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

Injected knowledge is currently added as a `system` message. Because extraction-sourced entries
are user-derived text, this grants them system-level authority in later turns — moving injection
to delimited, non-system content is owned by
[prd-knowledge.md Phase 6](./prd-knowledge.md#phase-6--injection-hardening-memory-as-untrusted-input--future).

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
| embedding | VECTOR(EMBEDDING_DIMENSIONS) | NULL              |
| createdAt | TIMESTAMP    | NOT NULL                       |
| updatedAt | TIMESTAMP    | NOT NULL                       |
| sourceGenerationId   | INTEGER   | FK → Generation, NULL — *Phase 5*   |
| sourceConversationId | INTEGER   | FK → Conversation, NULL — *Phase 5* |
| invalidatedAt        | TIMESTAMP | NULL — *Phase 5*                    |
| supersededByEntryId  | INTEGER   | FK → MemoryEntry, NULL — *Phase 5*  |
| importance           | REAL      | NULL — *Phase 8*                    |
| lastAccessedAt       | TIMESTAMP | NULL — *Phase 8*                    |
| accessCount          | INTEGER   | NOT NULL DEFAULT 0 — *Phase 8*      |

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

### MemoryEntityEdge Table

| Column          | Type      | Constraints                             |
| --------------- | --------- | --------------------------------------- |
| id              | INTEGER   | PK, auto-increment                      |
| subjectEntityId | INTEGER   | FK → MemoryEntity, NOT NULL             |
| predicate       | VARCHAR   | NOT NULL, canonical snake_case verb     |
| objectEntityId  | INTEGER   | FK → MemoryEntity, NOT NULL             |
| entryId         | INTEGER   | FK → MemoryEntry, NOT NULL (provenance) |
| invalidatedAt   | TIMESTAMP | NULL                                    |
| createdAt       | TIMESTAMP | NOT NULL                                |

**Indexes:**

- `UNIQUE (publicId)` on Memory, MemoryEntry, MemoryEntity tables
- `(memoryId)` on MemoryEntry — for listing entries within a memory
- `(projectId)` on MemoryEntity — for listing entities within a project
- `(actorId)` on MemoryEntity — for actor-scoped entity lookups (unique constraint)
- `(subjectEntityId, predicate)` on MemoryEntityEdge — forward traversal ("what does Pedro own?")
- `(objectEntityId, predicate)` on MemoryEntityEdge — reverse traversal ("who owns Company X?")
- `(entryId)` on MemoryEntityEdge — edges asserted by an entry (invalidation on supersede/delete)
- `UNIQUE (subjectEntityId, predicate, objectEntityId, entryId)` on MemoryEntityEdge — prevent duplicate edges per assertion
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
| `memories:ListEntityEdges`    | `GET /api/v1/entities/:entityId/edges`      |

Entity and edge creation is automatic (via async extraction during `writeMemoryEntry`). No `CreateMemoryEntity` permission needed — it piggybacks on `WriteMemoryEntry`.

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

Phase 5 adds `superseded` to the `action` values returned by the write endpoint and an
`include_invalidated` query parameter on entry listing (invalidated entries are excluded by
default).

### Entity Operations

| Method | Path                                 | Description                                     |
| ------ | ------------------------------------ | ----------------------------------------------- |
| GET    | `/api/v1/entities`                   | List entities in accessible projects            |
| GET    | `/api/v1/entities/:entityId`         | Get an entity by ID                             |
| PUT    | `/api/v1/entities/:entityId`         | Update entity (name, type, properties, actorId) |
| DELETE | `/api/v1/entities/:entityId`         | Delete an entity and its entry links            |
| GET    | `/api/v1/entities/:entityId/entries` | List entries linked to an entity                |
| GET    | `/api/v1/entities/:entityId/edges`   | List edges (subject → predicate → object) touching an entity |

Entities and edges are created automatically during `writeMemoryEntry()` (async, best-effort) — no `POST` endpoint. Users can update or delete extracted entities via `PUT`/`DELETE`. Entities are project-scoped; filter by `project_id` query parameter on `GET /api/v1/entities`.

### Agent Knowledge Config

No separate endpoints — use the standard agent update endpoint:

| Method | Path                      | Description                               |
| ------ | ------------------------- | ----------------------------------------- |
| PUT    | `/api/v1/agents/:agentId` | Update agent including `knowledge_config` |
