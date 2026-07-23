# PRD: Memory Module

## Implementation Status

Only outstanding work is tracked here. Shipped functionality (Phases 1–4, the
container/entry CRUD, tags, agent read/write, and automatic extraction) is documented in
the [Memory module docs](../packages/website/docs/modules/memories.md).

| Component                      | Status         | Notes                                                                                                                            |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Merge consolidation (LLM)      | 🟡 Partial    | Agent-tool + extraction merges consolidate into a single fact via the LLM (`memoryConsolidationCompletion.ts`), concat fallback; manual REST writes still concatenate (Phase 5) |
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

### Phase 5 — Write Algorithm v2 (LLM-Arbitrated, Temporal) 🟡 In progress

**Goal:** Replace the v1 threshold-decided, concatenation-merge write path with an LLM-arbitrated
decision over a shortlist of similar entries; add temporal invalidation (supersede) so
contradictions retire old facts instead of rewriting them; and record provenance so every entry is
auditable back to the conversation that produced it.

> **Delivered so far:** the **merge consolidation** step for writes with an agent context (the
> `write_memory` tool and automatic extraction) — an LLM consolidates both facts into a single
> atomic entry instead of concatenating (`memoryConsolidationCompletion.ts`, best-effort with a
> concat fallback). **Still pending:** the top-K shortlist + full add/update/supersede/skip
> arbitration, temporal invalidation, provenance, and consolidation for the manual REST write path
> (which has no agent context to resolve a provider — see the
> [merge provider decision](#5a--llm-arbitrated-write-decision) below).

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
- CRUD endpoints for entities: `GET/PUT/DELETE /api/v1/entities` (project-scoped, not nested under memories), plus `GET /api/v1/entities/{entity_id}/edges`
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
- Optional per-memory retention policy: `max_entries` and/or `ttl_days` on the Memory container.
  **Eviction order — deterministic total order.** When the valid-entry count exceeds
  `max_entries`, entries are evicted lowest-ranked first, ranked by this sequence (each level a
  tiebreak for the previous):
  1. invalidated entries first (`invalidatedAt` set), oldest `invalidatedAt` first
  2. then lowest `importance` (`null` sorts as the neutral 0.5)
  3. then lowest `accessCount` (fewest retrievals)
  4. then oldest `lastAccessedAt` (`null` = never accessed, sorts before any timestamp)
  5. tiebreak: oldest `createdAt`

  Eviction enforcement runs fire-and-forget after any write that leaves the memory above
  `max_entries` (no LLM call — a cheap ORDER BY delete), evicting until the count is back at the
  cap. `ttl_days` expiry is enforced by the daily sweep below.
- Compaction: `POST /api/v1/memories/{memory_id}/compact` clusters near-duplicate valid entries and
  merges each cluster through the v2 arbitration path. **Trigger cadence:** (a) manual via the
  endpoint, (b) enqueued fire-and-forget when a write leaves the memory's valid-entry count above
  the `max_entries` watermark, and (c) a daily scheduled sweep over memories with a retention
  policy. Compaction never runs on the write request path itself (it makes LLM calls; write
  latency must stay embedding-bound) — the on-write trigger only enqueues async work.
  *Rationale:* cap breaches are detected exactly at write time so compaction reacts without
  polling, while the daily sweep catches TTL expiry and memories that degrade without new writes.

**Unlocks:** Memories that stay useful at 10,000 entries, not just at 100.

---

### Phase 9 — Profile Memory (Always-Injected Blocks) ❌ Not started

> **Sketch** — to be expanded into concrete requirements before implementation begins.

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

## Acceptance Criteria (Interim)

Memory **quality** gates (retrieval precision/recall, contradiction-handling accuracy,
long-horizon recall) land with the knowledge module's evaluation harness — see
[prd-knowledge.md Phase 7](./prd-knowledge.md#phase-7--evaluation-harness-and-observability--future).
Until that harness exists, each remaining phase is accepted against the following
harness-independent, checkable criteria (verified with unit/REST tests per
`.claude/rules/tests.md`):

**Phase 5 — Write algorithm v2:**

- A write whose top match scores ≥ `duplicate_threshold` returns `action: "skipped"` without
  making an arbitration LLM call.
- A write with an empty shortlist (no candidate ≥ `shortlist_threshold`) creates an entry without
  making an arbitration LLM call.
- A supersede sets `invalidated_at` and `superseded_by_entry_id` on the old entry, creates the
  replacement, and returns `action: "superseded"`; the superseded entry no longer appears in
  knowledge search or default entry listing, and reappears with `include_invalidated=true`.
- If the arbitration LLM call fails, the write still completes under v1 fallback semantics — a
  failed arbitration never loses a write.
- Agent- and extraction-written entries carry `source_generation_id` (and
  `source_conversation_id` where applicable); manual entries carry neither.

**Phase 6 — Entity graph:**

- A create/update write returns before entity extraction runs (write latency is never LLM-bound);
  a failed extraction leaves the entry intact with no edges.
- "Pedro owns Company X and Maria owns Company Y" in a single entry yields exactly two edges with
  correct subject/object pairing.
- The same entity (same name and type) written via entries in two different memories of one
  project resolves to a single `mey_` entity.
- Superseding or deleting an entry invalidates/removes exactly the edges that entry asserted.

**Phase 7 — Extraction coverage:**

- A completed streaming generation with `extraction` + `write_memory_id` produces exactly one
  extraction, recorded on `metadata.extraction`.
- A `requires_action` turn triggers extraction once, only after its terminal `completed` state —
  never once per tool-output round-trip.
- Retries or repeated requests for the same generation never produce a second extraction
  (idempotency marker holds).

**Phase 8 — Forgetting:**

- A memory at `max_entries` accepts a new entry, and after eviction settles the valid-entry count
  never exceeds the cap.
- Eviction selects superseded (invalidated) entries before any active entry, and follows the
  deterministic total order defined in Phase 8 exactly (verifiable by constructing entries that
  differ in one ranking field at a time).
- An entry returned by knowledge search gets `lastAccessedAt`/`accessCount` updated
  fire-and-forget, without adding latency to the search response.
- Compaction never executes an LLM call on the write request path.

**Phase 9 — Profile memory:** no acceptance criteria yet — the phase is an explicit sketch;
criteria are defined when it is expanded into concrete requirements.

---

## Key Concepts (Pending Work)

### Memory Entity (Phase 6)

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

### Entity Graph (Edges) (Phase 6)

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

## Known v1 Limitations (addressed by Phase 5)

The shipped v1 write algorithm (see the [Memory module docs](../packages/website/docs/modules/memories.md))
decides create/update/skip from two fixed cosine thresholds and **concatenates** contents on
merge. Phase 5 replaces the decision and merge steps for the reasons below:

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

In write algorithm v2 (Phase 5) `duplicate_threshold` (default 0.95) still short-circuits
near-exact duplicates, a new `shortlist_threshold` (default 0.60) bounds the arbitration candidate
set, and the create/update/supersede decision moves to an LLM.

## Data Model (Pending Work)

The `Memory` and `MemoryEntry` base tables are shipped. Phase 5 adds columns to `MemoryEntry`
(`sourceGenerationId`, `sourceConversationId`, `invalidatedAt`, `supersededByEntryId`) and Phase 8
adds `importance`, `lastAccessedAt`, `accessCount`. The tables below are new in Phase 6.

### MemoryEntity Table (Phase 6)

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

### MemoryEntityEdge Table (Phase 6)

| Column          | Type      | Constraints                             |
| --------------- | --------- | --------------------------------------- |
| id              | INTEGER   | PK, auto-increment                      |
| subjectEntityId | INTEGER   | FK → MemoryEntity, NOT NULL             |
| predicate       | VARCHAR   | NOT NULL, canonical snake_case verb     |
| objectEntityId  | INTEGER   | FK → MemoryEntity, NOT NULL             |
| entryId         | INTEGER   | FK → MemoryEntry, NOT NULL (provenance) |
| invalidatedAt   | TIMESTAMP | NULL                                    |
| createdAt       | TIMESTAMP | NOT NULL                                |

**Indexes (new in Phase 6):**

- `UNIQUE (publicId)` on MemoryEntity
- `(projectId)` on MemoryEntity — for listing entities within a project
- `(actorId)` on MemoryEntity — for actor-scoped entity lookups (unique constraint)
- `(subjectEntityId, predicate)` on MemoryEntityEdge — forward traversal ("what does Pedro own?")
- `(objectEntityId, predicate)` on MemoryEntityEdge — reverse traversal ("who owns Company X?")
- `(entryId)` on MemoryEntityEdge — edges asserted by an entry (invalidation on supersede/delete)
- `UNIQUE (subjectEntityId, predicate, objectEntityId, entryId)` on MemoryEntityEdge — prevent duplicate edges per assertion
- `HNSW (embedding)` on MemoryEntity — for cosine similarity search

## Permissions (Pending Work)

### Entity Operations (Phase 6)

| Permission                    | Endpoint                            |
| ----------------------------- | ----------------------------------- |
| `memories:ListMemoryEntities` | `GET /api/v1/entities`                      |
| `memories:GetMemoryEntity`    | `GET /api/v1/entities/{entity_id}`            |
| `memories:UpdateMemoryEntity` | `PUT /api/v1/entities/{entity_id}`            |
| `memories:DeleteMemoryEntity` | `DELETE /api/v1/entities/{entity_id}`         |
| `memories:ListEntityEntries`  | `GET /api/v1/entities/{entity_id}/entries`    |
| `memories:ListEntityEdges`    | `GET /api/v1/entities/{entity_id}/edges`      |

Entity and edge creation is automatic (via async extraction during `writeMemoryEntry`). No `CreateMemoryEntity` permission needed — it piggybacks on `WriteMemoryEntry`.

## REST API (Pending Work)

All body fields use `snake_case` per project convention. Phase 5 adds `superseded` to the `action`
values returned by the write endpoint (`POST /api/v1/memories/{memory_id}/entries`) and an
`include_invalidated` query parameter on entry listing (invalidated entries are excluded by
default).

### Entity Operations (Phase 6)

| Method | Path                                 | Description                                     |
| ------ | ------------------------------------ | ----------------------------------------------- |
| GET    | `/api/v1/entities`                   | List entities in accessible projects            |
| GET    | `/api/v1/entities/{entity_id}`         | Get an entity by ID                             |
| PUT    | `/api/v1/entities/{entity_id}`         | Update entity (name, type, properties, actorId) |
| DELETE | `/api/v1/entities/{entity_id}`         | Delete an entity and its entry links            |
| GET    | `/api/v1/entities/{entity_id}/entries` | List entries linked to an entity                |
| GET    | `/api/v1/entities/{entity_id}/edges`   | List edges (subject → predicate → object) touching an entity |

Entities and edges are created automatically during `writeMemoryEntry()` (async, best-effort) — no `POST` endpoint. Users can update or delete extracted entities via `PUT`/`DELETE`. Entities are project-scoped; filter by `project_id` query parameter on `GET /api/v1/entities`.
