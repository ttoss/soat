# PRD: Memory Module

## Implementation Status

Only outstanding work is tracked here. Shipped functionality — memory stores, memories, tags,
agent read and write, memory rules, the assertion ledger, threshold and declared supersede,
retraction and export — is documented in the
[Memory module docs](../packages/website/docs/modules/memories.md).

| Component                           | Status         | Notes                                                                                                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restore                             | ❌ Not started | `POST /api/v1/memories/{memory_id}/restore` reinstates an invalidated memory (Phase 5a)                                                          |
| Declared supersede for agents       | ❌ Not started | `supersedes` on the `write_memory` tool and on the rule handler contract (Phase 5a)                                                              |
| Write algorithm v2 (arbitrated)     | ❌ Not started | Top-K shortlist + LLM decision, with the arbiter set on the memory store (Phase 5b)                                                              |
| MemoryEntity model                  | ❌ Not started | Project-scoped extracted nouns/objects with `mey_` prefix, embedding column, optional `actorId` FK; deduplicated across stores (Phase 6)         |
| MemoryEntityEdge model              | ❌ Not started | First-class entity→entity edges: subject, canonical predicate, object, provenance memory, validity (Phase 6)                                     |
| Entity extraction on write          | ❌ Not started | Async, off the request path; LLM extracts subject/predicate/object triples after the memory persists (Phase 6)                                   |
| Entity-based knowledge queries      | ❌ Not started | Memory-side `resolveEntitySearch()` (entity/actor → edges → memories). Query surface specced in prd-knowledge.md Phase 3 (Phase 6)               |
| Rule-firing tests                   | ❌ Not started | `requires_action` and background (`wait=false`) direct generations fire rules through `generations.completed`; neither path has a test (Phase 7) |
| Forgetting                          | ❌ Not started | Importance, use and reaffirmation tracking, retention by retraction, purge window, compaction (Phase 8)                                          |
| Profile memory                      | ❌ Not started | Always-injected bounded block per actor, agent-editable (Phase 9)                                                                                |
| Index on `memories.memory_store_id` | ❌ Not started | See [Engine Findings](#engine-findings)                                                                                                          |

## Implementation Phases

### Phase 5 — Contradiction Handling ❌ Not started

**Goal:** Retire a fact when a later one contradicts it — including where cosine cannot see the
contradiction — and make every retirement reversible.

**Motivation:** The write path decides from cosine alone: `skipped` at or above
`duplicate_threshold` (0.95), `superseded` at or above `supersede_threshold` (0.90), `created`
below both — or `superseded` outright when the caller names the target in `supersedes`. Four gaps
follow:

- **Contradictions coexist.** "We closed the Lisbon office" scores below 0.90 against "The office
  is in Lisbon", so both stay valid. Only a REST caller naming `supersedes` retires the old fact;
  the `write_memory` tool and rule handlers cannot name one.
- **Near-duplicates accumulate** below 0.90 on every path.
- **Top-1 only, model-coupled.** A new fact can overlap several memories, but only the closest is
  compared, and the cutoffs do not port across embedding models (see
  [Engine Findings](#engine-findings)).
- **Retirement is one-way.** A wrongly superseded or retracted fact comes back only as a new
  memory written again; nothing reinstates the original.

5a closes the first gap for agents and the last one for every caller, with no model call. 5b adds
an arbiter for the rest.

#### 5a — Restore, and declared supersede for agents

- `POST /api/v1/memories/{memory_id}/restore` reinstates an invalidated memory: it clears
  `invalidated_at` and `superseded_by_memory_id` and appends an assertion with outcome `restored`.
  - A superseded memory is restored only while its successor is still valid; the successor is
    retracted in the same transaction, with its own `retracted` assertion. A successor that is
    itself superseded answers `409`: a chain is restored from its head down.
  - A valid memory answers `409`. Restore skips deduplication — like `supersedes`, it is a
    declaration.
  - Permission `memories:RestoreMemory`, beside `memories:RetractMemory`.
- `supersedes` on the `write_memory` tool input, optional. The target must be a memory shown to
  the agent in this generation — injected by its `knowledge_config` retrieval (the generation's
  `retrieval` record) or returned by a knowledge search it made — and in the tool's write store.
  Any other target is a tool error and writes nothing: a model retires only a fact it was shown,
  never one whose id it guessed or read in retrieved text. The injected context already carries
  each memory's id.
- `supersedes` on the rule handler contract:
  `{ "facts": [{ "content": "...", "tags": {}, "supersedes": "mem_..." }] }`. An agent handler is
  held to the tool's rule against its own generation; a tool handler to the REST rule (a valid
  memory in the destination store). An invalid target drops that fact, never the firing.
- No new grant: the tool already requires both `memories:CreateMemory` and
  `memories:UpdateMemory` on the store.

#### 5b — LLM-arbitrated write decision

```
Input: content (string), memory_store_id

STEP 1 — EMBED (best-effort, as today)

STEP 2 — SHORTLIST
  Retrieve the top-K (default 5) valid memories by cosine similarity.
  If topMatch.score ≥ duplicate_threshold (default 0.95) → SKIP (no LLM call).
  Drop candidates below shortlist_threshold (default 0.60).
  If the shortlist is empty → CREATE (no LLM call).

STEP 3 — ARBITRATE (LLM)
  Given the incoming fact and the shortlisted memories, the model picks:
    - add           → genuinely new knowledge
    - update(id)    → refines a shortlisted memory; returns ONE consolidated
                      atomic fact (not a concatenation)
    - supersede(id) → contradicts a shortlisted memory
    - skip          → already known

  Output: { operation, target_memory_id?, content? }

STEP 4 — APPLY
  add       → create a memory
  update    → supersede the target with the consolidated fact
  supersede → supersede the target with the incoming fact
  skip      → no-op

STEP 5 — RETURN { action: "created" | "superseded" | "skipped", memory }
```

- `update` and `supersede` differ only in the text the replacement carries. Both keep the target
  readable with `invalidated_at` and `superseded_by_memory_id` set, so `include_invalidated` and
  the ledger hold the whole history, and `action` keeps its three values.
- The arbiter is set on the memory store — `ai_provider_id` and `model`, the override shape memory
  rules use — so every door (REST, tool, rule, formation) arbitrates the same way. A store without
  an arbiter keeps the threshold algorithm.
- A declared `supersedes` bypasses arbitration.
- **Fallback:** if the arbiter call fails, the threshold algorithm decides — a failed call never
  loses a write.
- Thresholds change roles: `duplicate_threshold` short-circuits near-exact duplicates,
  `shortlist_threshold` (store default and per request, like the other two) bounds the candidate
  set, and `supersede_threshold` decides only when no arbiter does.
- The assertion records `arbitrated: true` beside `declared`, and the shortlisted memory ids.

**Unlocks:** Trustworthy memory — contradictions resolve into the supersede chain instead of
accumulating, merged facts stay atomic, and a wrong call is one `restore` away.

---

### Phase 6 — Entity Graph Layer ❌ Not started

> **Demand-gated.** This phase builds only when both roadmap gates fire — a
> measured hybrid-retrieval gap on the Knowledge golden set, plus
> observed user demand. The gates, the cheaper fallback, and the rationale live
> in [roadmap.md](./roadmap.md#entity-graph-memories-phase-6--knowledge-phase-3--demand-gated);
> a finished design here is not a green light.

**Goal:** Extract structured entities and relationships from memories so knowledge can be queried by graph traversal — not just vector similarity. Enables precise queries like "everything about Pedro" or "what does Company X own?" without relying on embedding proximity.

**Motivation:** Vector search excels at semantic similarity ("find things related to billing") but is weak for structural/relational queries. A memory "Pedro owns Company X" embeds as a single vector — querying for "Pedro" may not surface it if the embedding space doesn't place it close enough. An entity graph layer decomposes memories into queryable nodes (entities) and edges (relationships), enabling exact lookups and traversals.

| Query type                              | Vector search                                         | Entity graph                          |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| "What do we know about billing?"        | ✅ Good                                               | ⚠️ Requires entity indexing           |
| "What does Pedro own?"                  | ⚠️ Fuzzy — returns anything _similar_ to "Pedro owns" | ✅ Exact — traverse Pedro → owns → \* |
| "All entities connected to Company X"   | ❌ Poor                                               | ✅ Direct graph traversal             |
| "All memories involving actor `act_01`" | ❌ Impossible without metadata                        | ✅ Direct FK lookup                   |

**Deliverables:**

#### 6a — MemoryEntity + MemoryEntityEdge models

- `MemoryEntity` model (`mey_` prefix) — **project-scoped**, deduplicated nouns/objects extracted from memories, with optional `actorId` FK for entities that correspond to known actors
- Entities live at **project level**, not store level — enabling cross-store graph traversal ("find everything about Pedro across all stores")
- `MemoryEntityEdge` model — a first-class **entity → entity** edge: `{ subjectEntityId, predicate, objectEntityId, memoryId, invalidatedAt }`. The memory is the edge's **provenance** (which fact asserted it), not a party to it. This keeps triples unambiguous: "Pedro owns Company X and Maria owns Company Y" in one memory produces two edges whose subject/object pairing is explicit — a memory↔entity join table would produce four same-verb mention rows that cannot be re-paired into triples
- **Canonical predicates** — extraction normalizes verbs to a canonical snake_case predicate before storage (`"is the owner of"` → `owns`). Free-form labels fragment the graph and make `predicate` filters miss; the predicate set is open, but normalization is mandatory
- **Edge validity** — edges carry `invalidatedAt`. Superseding or retracting a memory invalidates the edges it asserted in the same transaction (no LLM involved), deleting it removes them, and a restore re-validates them
- CRUD endpoints for entities: `GET/PUT/DELETE /api/v1/entities` (project-scoped, not nested under memory stores), plus `GET /api/v1/entities/{entity_id}/edges`
- Entity deduplication by embedding similarity within a project (same two-threshold pattern as memories)

#### 6b — Async entity extraction on write

- When `writeMemory()` creates a memory, or a `PUT` changes a memory's content, run a lightweight LLM extraction to decompose the content into `[{ subject, predicate, object }]` triples
- Upsert entities by name within the **project** (deduplicate by embedding similarity); create edges with canonical predicates and the memory as provenance
- **Asynchronous, best-effort:** extraction runs **off the request path** (fire-and-forget after the memory is persisted, as memory rules do) so write latency is never LLM-bound. If it fails, the memory still exists — entities are an enrichment, not a critical path
- Entity extraction from a single atomic memory is cheap (~500ms LLM call), unlike a rule's turn-level extraction — but still too slow to sit inside a REST write

#### Entity Deduplication & Resolution

Entities are deduplicated at **project scope** so the same real-world concept is represented once across all stores. Resolution uses a layered strategy:

1. **Actor-anchored identity (hard match):** If the LLM extraction identifies an entity that matches a known actor (by name or `externalId`), set `actorId` on the entity. Any future entity with the same `actorId` is definitionally the same — skip embedding dedup.

2. **Embedding similarity (soft match):** For non-actor entities, embed `"{name} ({entityType})"` and search existing project-level entities using the two-threshold approach:
   - ≥ 0.95 — same entity → reuse existing
   - 0.75–0.95 — likely same → reuse and enrich properties
   - < 0.75 — different entity → create new

3. **Type-aware disambiguation:** Including `entityType` in the embedding input prevents false merges between same-named entities of different types (e.g., "Pedro" the person vs "Pedro" the project).

**Example — cross-store resolution:**

```
Store A memory: "Pedro owns Company X"
  → extracts entity "Pedro" (person) → creates project entity mey_pedro
  → extracts entity "Company X" (organization) → creates project entity mey_companyX

Store B memory: "Pedro prefers email"
  → extracts entity "Pedro" (person) → embedding match ≥ 0.95 against mey_pedro → reuse
  → links the Store B memory to the same mey_pedro entity

Query: "all memories about Pedro" → returns memories from both Store A and Store B
```

```
writeMemory() flow, with Phase 6:
  1. Embed content
  2. Write decision → created/superseded/skipped (thresholds, or the
     arbiter after 5b). A supersede invalidates the retired memory's
     edges in the same transaction.
  3. If created or superseded:
     a. Persist the memory
     b. Enqueue (fire-and-forget, best-effort): extract entities + upsert + link
        Prompt: "Extract entities and relationships from: <content>"
        → [{ subject: string, predicate: string, object: string }]
        For each triple:
          - Upsert subject entity (deduplicate by embedding within project)
          - Upsert object entity (deduplicate by embedding within project)
          - Normalize the predicate to canonical snake_case
          - Create a MemoryEntityEdge { subject, predicate, object, memoryId }
        On failure: log warning — memory exists, edges don't
        (Orphaned entities are pruned separately, not here.)
  4. Return { action, memory }   # never blocked on entity extraction
```

#### 6c — Entity-based knowledge queries

The **query surface** for entity-based search (the `entity_ids`, `entity_names`, `actor_ids`,
`entity_types`, `predicate`, and `direction` parameters; query modes; ranking) is owned by
the knowledge module — see [prd-knowledge.md Phase 3 — Entity Graph Queries](./prd-knowledge.md#phase-3--entity-graph-queries--future).
This phase delivers the **memory-side data layer** that Phase 3 queries against:

- `resolveEntitySearch()` resolves entities by ID / name / actor / type, follows their
  `MemoryEntityEdge` edges (applying `predicate` / `direction` filters), and maps matched edges
  to their provenance memories.
- Entity filters narrow the candidate set; when a `query` is present, vector search ranks within it.
- Memory-type results are enriched with their linked entities (see [Entity Graph (Edges)](#entity-graph-edges-phase-6)).
- **Single-hop only:** entity → edges → memories. Multi-hop path traversal ("how are Pedro and
  Company X related?") is out of scope until a dedicated path-query design exists.

**Unlocks:** Precise, structured knowledge retrieval. Agents can answer "what do we know about this customer?" with exact graph queries instead of hoping vector similarity surfaces the right memories.

---

### Phase 7 — Rule-Firing Coverage ❌ Not started

**Goal:** Pin with tests that every turn type fires memory rules. Rules bind to
`generations.completed`, which every completion path emits — blocking, streaming, a turn resumed
after client-tool outputs, and a background (`wait=false`) direct generation. The streamed turn and
the conversation paths are tested; two paths are not.

**Deliverables** (in `memoryRuleDispatch.test.ts`):

- A `requires_action` direct generation fires a `generations.completed` rule once, after its
  terminal completion — never once per `tool-outputs` round-trip.
- A background (`wait=false`) direct generation fires the rule exactly once, as its blocking twin
  does.

**Unlocks:** The claim that passive memory covers every transport is held by tests, not by reading
the emit sites.

---

### Phase 8 — Forgetting (Importance, Use, Retention, Compaction) ❌ Not started

**Goal:** Keep memory stores healthy as they grow. A store with no forgetting degrades — retrieval
fills with stale, trivial, or redundant facts — while a store that forgets by deleting loses the
history the supersede chain exists to keep. Forgetting here retires facts the way a supersede
does: out of listing, dedup and search, still readable by id, and reversible with `restore`.

**Deliverables:**

- `importance` (0–1) on `Memory`, assigned by the 5b arbiter or proposed by a rule handler;
  `null` counts as 0.5.
- **Use:** `last_used_at` + `use_count` on `Memory`, updated fire-and-forget when a memory reaches
  an agent — injected by `knowledge_config` retrieval (exactly what the generation's `retrieval`
  record lists) or returned by a knowledge search the agent makes during a generation. A REST
  knowledge search does not count: dashboards and the retrieval eval would otherwise make every
  memory look used.
- **Reaffirmation:** `last_reaffirmed_at` on `Memory`, set when a write resolves to `skipped`
  against it — the fact was stated again. A `skipped` write leaves `updated_at` untouched, so
  without this a fact restated every week ages as if nobody had mentioned it. The ledger already
  records each such write; the column keeps ranking from aggregating the ledger.
- **Retrieval-time blend**, owned by the knowledge module's ranking layer (see
  [prd-knowledge.md Phase 5](./prd-knowledge.md#phase-5--rerank-and-importance-weighting--future)):
  the shipped recency factor measures age from the later of `updated_at` and
  `last_reaffirmed_at`, and `importance` multiplies the fused score. Use stays out of ranking: a
  memory ranked high because it was retrieved, and retrieved because it ranked high, would never
  age. Use feeds retention instead.
- **Retention** on `MemoryStore`: `max_memories` and/or `ttl_days`. Both act by **retraction** —
  an assertion with outcome `retracted` and mechanism `retention` records each one.
  - `max_memories` counts valid memories. When a write leaves the store above it, valid memories
    are retracted lowest-ranked first, in this total order (each level a tiebreak for the
    previous): lowest `importance`, then lowest `use_count`, then oldest `last_used_at` (`null` =
    never used, before any timestamp), then oldest `created_at`. Enforcement runs fire-and-forget
    after the write — an ORDER BY, no LLM call.
  - `ttl_days` retracts, in a daily sweep, every valid memory whose later of `created_at` and
    `last_reaffirmed_at` is older than the window: a fact restated within its lifetime lives on.
- **Purge window:** `purge_invalidated_after_days` on `MemoryStore` (`null`, the default, keeps
  invalidated memories forever). The daily sweep deletes memories invalidated longer ago than the
  window, with the content rows only they reference. Invalidated memories still count toward
  storage — their `memory_contents` bytes stay — so this is the knob that frees it. Their
  assertions keep their rows with `memory_id` set to null, as on `DELETE`.
- **Compaction:** `POST /api/v1/memory-stores/{memory_store_id}/compact` (`wait` in the query
  string, per `sync-async.md`) clusters near-duplicate valid memories and merges each cluster
  through the 5b arbiter into one memory that supersedes every member — each member points at the
  merged memory, and each assertion carries mechanism `compaction`. A store without an arbiter
  answers `400`. **Trigger cadence:** (a) manual via the endpoint, (b) enqueued fire-and-forget
  when a write leaves the store above `max_memories`, and (c) a daily sweep over stores with a
  retention policy. Compaction never runs on the write request path itself: it makes LLM calls,
  and write latency must stay embedding-bound.

**Unlocks:** Stores that stay useful at 10,000 memories, not just at 100, without losing the record
of what was believed and when.

---

### Phase 9 — Profile Memory (Always-Injected Blocks) ❌ Not started

> **Sketch** — to be expanded into concrete requirements before implementation begins.

**Goal:** Add the second memory kind production assistants need: a small, bounded **profile**
that is always in context, alongside the retrieved fact store. Top-k retrieval is probabilistic;
for durable, high-value context ("customer is Pedro, prefers email, timezone EST") the state of
the art (Letta/MemGPT core memory blocks, ChatGPT's user profile) keeps a compact block always
injected and lets the agent edit it.

**Sketch (to be refined before implementation):**

- `type` on `MemoryStore`: `facts` (default — current behavior) | `profile`
- A profile store holds one bounded content block (e.g. 2–4 KB) **per actor**, plus at most one
  block with no actor for the whole project. A turn injects the block of its conversation's actor
  and the project block — never another actor's. One block per store, injected into every
  conversation, would put one customer's profile in front of another.
- Injected **in full** for agents whose `knowledge_config` references the store — no vector
  retrieval — inside the fenced `user` knowledge block, below the agent's own instructions and
  never as `system`, under the same threat model as retrieved knowledge.
- `update_profile` soat-tool (rewrite-in-place semantics) edits the current actor's block only,
  bound via `knowledge_config` the same way `write_memory` is. Each rewrite appends an assertion.
- Rule variant: a memory rule whose destination is a profile store consolidates the turn's facts
  **into** the actor's block (rewrite) rather than writing memories.

**Out of scope for now:** procedural memory (learned instructions/skills) — see
[Out of Scope](#out-of-scope).

---

## Acceptance Criteria (Interim)

Memory **quality** gates (contradiction handling, multi-session recall, point-in-time recall)
land with the knowledge module's memory-pipeline evals — see
[prd-knowledge.md Phase 7](./prd-knowledge.md#phase-7--memory-pipeline-evals--future).
Each remaining phase is also accepted against these harness-independent, checkable criteria
(unit/REST tests per `.claude/rules/tests.md`):

**Phase 5a — Restore, and declared supersede for agents:**

- Restoring a retracted memory makes it valid again and appends a `restored` assertion; it
  reappears in listing, dedup and knowledge search.
- Restoring a superseded memory whose successor is valid reinstates it and retracts the successor
  in one transaction; a successor that is itself superseded answers `409`, and so does a valid
  memory.
- A `write_memory` call naming a memory not shown to the agent in that generation writes nothing
  and returns a tool error; naming a shown one returns `superseded` with `declared: true` on the
  assertion.
- A rule handler fact naming an invalid target is dropped; the firing's other facts are written.

**Phase 5b — Write algorithm v2:**

- A write whose top match scores ≥ `duplicate_threshold` returns `action: "skipped"` without
  making an arbitration LLM call.
- A write with an empty shortlist (no candidate ≥ `shortlist_threshold`) creates a memory without
  making an arbitration LLM call.
- An arbitrated `update` or `supersede` sets `invalidated_at` and `superseded_by_memory_id` on the
  target, creates the replacement, returns `action: "superseded"`, and records `arbitrated: true`.
- If the arbitration LLM call fails, the write still completes under threshold semantics — a
  failed arbitration never loses a write.
- A store without an arbiter writes exactly as the threshold algorithm does.

**Phase 6 — Entity graph:**

- A create/update write returns before entity extraction runs (write latency is never LLM-bound);
  a failed extraction leaves the memory intact with no edges.
- "Pedro owns Company X and Maria owns Company Y" in a single memory yields exactly two edges with
  correct subject/object pairing.
- The same entity (same name and type) written via memories in two different stores of one
  project resolves to a single `mey_` entity.
- Superseding, retracting or deleting a memory invalidates/removes exactly the edges that memory
  asserted; restoring it re-validates them.

**Phase 7 — Rule-firing coverage:** the two deliverable tests pass.

**Phase 8 — Forgetting:**

- A store at `max_memories` accepts a new memory, and after eviction settles the valid-memory count
  never exceeds the cap; every evicted memory is retracted with mechanism `retention`, never
  deleted, and `restore` brings it back.
- Eviction follows the total order defined in Phase 8 exactly (verifiable by constructing memories
  that differ in one ranking field at a time).
- A memory injected into a turn gets `last_used_at`/`use_count` updated fire-and-forget, without
  adding latency to the turn; a REST knowledge search changes neither.
- A `skipped` write sets the matched memory's `last_reaffirmed_at`.
- The purge sweep deletes only memories invalidated longer ago than `purge_invalidated_after_days`,
  and the storage they held is freed.
- Compaction never executes an LLM call on the write request path; every merged member points at
  the merged memory through `superseded_by_memory_id`.

**Phase 9 — Profile memory:** no acceptance criteria yet — the phase is an explicit sketch;
criteria are defined when it is expanded into concrete requirements. The first one is fixed: a
turn never injects another actor's block.

---

## Out of Scope

- **Promoting memories into always-loaded instructions** — learned rules, deferred in
  [roadmap.md](./roadmap.md) (G6).
- **Cross-agent handoffs and messaging** — a baton one session claims exactly once is a
  coordination primitive, not memory.
- **Files as the source of truth** — memories live in Postgres;
  `GET /api/v1/memory-stores/{memory_store_id}/export` is the portable form.

## Contract Additions

Pending phases add values to shipped response enums: assertion `outcome` gains `restored` (5a),
and assertion `mechanism` gains `retention` and `compaction` (Phase 8). Whether those values are
reserved before the v1 RC or the two enums are declared open is an open decision in
[roadmap.md](./roadmap.md#open-contract-decision--new-enum-values). Every other addition — routes,
request fields, response fields — is additive.

## Key Concepts (Pending Work)

### Memory Entity (Phase 6)

A memory entity is a noun, object, or concept extracted from memories. Entities are **project-scoped** — they live at the project level, not inside a specific store. This enables cross-store graph traversal: the same entity can be linked to memories in different stores.

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

- Entities are **project-scoped** — deduplicated across all stores in a project. The same real-world concept (e.g., "Pedro") is represented by a single entity, even when referenced from memories in different stores.
- Entities are **deduplicated by a layered strategy** — actor-anchored identity (hard match via `actorId`) takes precedence; for non-actor entities, embedding similarity of `"{name} ({entityType})"` is used with the same two-threshold approach as memories.
- Entities can be **linked to actors** — if an entity corresponds to a known actor in the project, setting `actor_id` provides canonical identity. Any future entity with the same `actor_id` is definitionally the same entity.
- Entities have **properties** — free-form JSONB for structured attributes that don't fit the name/type fields. Properties are enriched on merge (similarity 0.75–0.95).

### Entity Graph (Edges) (Phase 6)

Relationships are modeled as first-class **entity → entity edges**. An edge is a directed triple —
subject entity, canonical predicate, object entity — with the memory that asserted it as
provenance:

| Field               | Type     | Description                                                   |
| ------------------- | -------- | ------------------------------------------------------------- |
| `subject_entity_id` | FK       | The entity doing the action                                   |
| `predicate`         | string   | Canonical snake_case verb (`owns`, `works_at`, `prefers`)     |
| `object_entity_id`  | FK       | The entity receiving the action                               |
| `memory_id`         | FK       | The memory that asserted this edge (provenance)               |
| `invalidated_at`    | datetime | Set while the asserting memory is invalidated; `null` = valid |

**Example:** Memory "Pedro owns Company X" produces:

```
Entity: { name: "Pedro", entity_type: "person", actor_id: "act_01" }   # project-scoped
Entity: { name: "Company X", entity_type: "organization" }              # project-scoped

Edge: { subject: mey_pedro, predicate: "owns", object: mey_companyX, memory: mem_001 }
```

Edges connect entities to entities (with the memory as provenance) rather than linking memories to
entities with a label. This keeps triples unambiguous: "Pedro owns Company X and Maria owns
Company Y" yields two edges whose subject/object pairing is explicit, where four memory↔entity
mention rows sharing the same verb could not be re-paired into triples.

This enables queries like:

- "All memories about Pedro" → match entity by name → its edges → provenance memories (from **any** store in the project)
- "What does Pedro own?" → edges where subject = Pedro and predicate = `owns` → objects + memories
- "All memories involving actor `act_01`" → entity with that `actor_id` → its edges → memories
- Multi-hop path traversal ("how are Pedro and Company X related?") is a **future extension** — the initial query surface is single-hop (see prd-knowledge.md Phase 3)

## Engine Findings

Open findings from the code-level engine review; sequencing stays in [roadmap.md](./roadmap.md).

### Cosine thresholds are deployment-tuned, not portable

`duplicate_threshold` and `supersede_threshold` are raw cosine values, so a tuned value is coupled
to the deployment's embedding model — the caveat the knowledge docs state for `min_similarity`.
The module docs should document both as deployment-tuned knobs, not portable constants. 5b narrows
`duplicate_threshold` to short-circuiting near-exact duplicates, where model differences matter
least.

### No index on `memories.memory_store_id`

Listing a store and the store filter of every dedup lookup read `memories.memory_store_id`, which
has no index — `public_id`, `tags` and `content_id` do, and the HNSW index is on
`memory_contents.embedding`. A b-tree on `memories.memory_store_id` is invisible to the contract
and additive; it should land before 10k-memory stores are a real workload, and it gates how much
Phase 8 can matter in practice.

## Data Model (Pending Work)

The `MemoryStore`, `Memory`, `MemoryContent`, `MemoryAssertion` and `MemoryRule` tables are
shipped. Pending columns on them:

| Table           | Columns                                                    | Phase |
| --------------- | ---------------------------------------------------------- | ----- |
| MemoryStore     | `aiProviderId`, `model`, `shortlistThreshold`              | 5b    |
| MemoryAssertion | `arbitrated`, `shortlistMemoryIds`                         | 5b    |
| Memory          | `importance`, `lastUsedAt`, `useCount`, `lastReaffirmedAt` | 8     |
| MemoryStore     | `maxMemories`, `ttlDays`, `purgeInvalidatedAfterDays`      | 8     |
| MemoryStore     | `type`                                                     | 9     |

The tables below are new in Phase 6.

### MemoryEntity Table (Phase 6)

| Column     | Type                         | Constraints                     |
| ---------- | ---------------------------- | ------------------------------- |
| id         | INTEGER                      | PK, auto-increment              |
| publicId   | VARCHAR(32)                  | UNIQUE, NOT NULL, `mey_` prefix |
| projectId  | INTEGER                      | FK → Project, NOT NULL          |
| name       | VARCHAR                      | NOT NULL                        |
| entityType | VARCHAR(50)                  | NULL                            |
| actorId    | INTEGER                      | FK → Actor, NULL (unique)       |
| properties | JSONB                        | NULL, default `{}`              |
| embedding  | VECTOR(EMBEDDING_DIMENSIONS) | NULL                            |
| createdAt  | TIMESTAMP                    | NOT NULL                        |
| updatedAt  | TIMESTAMP                    | NOT NULL                        |

### MemoryEntityEdge Table (Phase 6)

| Column          | Type      | Constraints                         |
| --------------- | --------- | ----------------------------------- |
| id              | INTEGER   | PK, auto-increment                  |
| subjectEntityId | INTEGER   | FK → MemoryEntity, NOT NULL         |
| predicate       | VARCHAR   | NOT NULL, canonical snake_case verb |
| objectEntityId  | INTEGER   | FK → MemoryEntity, NOT NULL         |
| memoryId        | INTEGER   | FK → Memory, NOT NULL (provenance)  |
| invalidatedAt   | TIMESTAMP | NULL                                |
| createdAt       | TIMESTAMP | NOT NULL                            |

**Indexes (new in Phase 6):**

- `UNIQUE (publicId)` on MemoryEntity
- `(projectId)` on MemoryEntity — for listing entities within a project
- `(actorId)` on MemoryEntity — for actor-scoped entity lookups (unique constraint)
- `(subjectEntityId, predicate)` on MemoryEntityEdge — forward traversal ("what does Pedro own?")
- `(objectEntityId, predicate)` on MemoryEntityEdge — reverse traversal ("who owns Company X?")
- `(memoryId)` on MemoryEntityEdge — edges asserted by a memory (invalidation on supersede, retraction or delete)
- `UNIQUE (subjectEntityId, predicate, objectEntityId, memoryId)` on MemoryEntityEdge — prevent duplicate edges per assertion
- `HNSW (embedding)` on MemoryEntity — for cosine similarity search

## Permissions (Pending Work)

| Permission                    | Endpoint                                               | Phase |
| ----------------------------- | ------------------------------------------------------ | ----- |
| `memories:RestoreMemory`      | `POST /api/v1/memories/{memory_id}/restore`            | 5a    |
| `memories:CompactMemoryStore` | `POST /api/v1/memory-stores/{memory_store_id}/compact` | 8     |
| `memories:ListMemoryEntities` | `GET /api/v1/entities`                                 | 6     |
| `memories:GetMemoryEntity`    | `GET /api/v1/entities/{entity_id}`                     | 6     |
| `memories:UpdateMemoryEntity` | `PUT /api/v1/entities/{entity_id}`                     | 6     |
| `memories:DeleteMemoryEntity` | `DELETE /api/v1/entities/{entity_id}`                  | 6     |
| `memories:ListEntityMemories` | `GET /api/v1/entities/{entity_id}/memories`            | 6     |
| `memories:ListEntityEdges`    | `GET /api/v1/entities/{entity_id}/edges`               | 6     |

Entity and edge creation is automatic (via async extraction after `writeMemory()`). No `CreateMemoryEntity` permission needed — it piggybacks on `memories:CreateMemory`.

## REST API (Pending Work)

All body fields use `snake_case` per project convention. Pending request fields: `supersedes` on
the `write_memory` tool input and on the rule handler contract (5a); `ai_provider_id`, `model` and
`shortlist_threshold` on memory stores, and `shortlist_threshold` per write (5b);
`max_memories`, `ttl_days` and `purge_invalidated_after_days` on memory stores (Phase 8); `type`
on memory stores (Phase 9). Pending response fields: `importance`, `last_used_at`, `use_count` and
`last_reaffirmed_at` on memories (Phase 8); `arbitrated` and the shortlisted memory ids on
assertions (5b).

| Method | Path                                              | Description                                                                             |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| POST   | `/api/v1/memories/{memory_id}/restore`            | Reinstate an invalidated memory (5a)                                                    |
| POST   | `/api/v1/memory-stores/{memory_store_id}/compact` | Merge near-duplicate clusters through the arbiter; `wait` in the query string (Phase 8) |
| GET    | `/api/v1/entities`                                | List entities in accessible projects (Phase 6)                                          |
| GET    | `/api/v1/entities/{entity_id}`                    | Get an entity by ID (Phase 6)                                                           |
| PUT    | `/api/v1/entities/{entity_id}`                    | Update entity (name, type, properties, actorId) (Phase 6)                               |
| DELETE | `/api/v1/entities/{entity_id}`                    | Delete an entity and its edges (Phase 6)                                                |
| GET    | `/api/v1/entities/{entity_id}/memories`           | List memories linked to an entity (Phase 6)                                             |
| GET    | `/api/v1/entities/{entity_id}/edges`              | List edges (subject → predicate → object) touching an entity (Phase 6)                  |

Entities and edges are created automatically after `writeMemory()` (async, best-effort) — no `POST` endpoint. Users can update or delete extracted entities via `PUT`/`DELETE`. Entities are project-scoped; filter by `project_id` query parameter on `GET /api/v1/entities`.
