# PRD: Knowledge Module

## Implementation Status

Only outstanding work is tracked here; shipped functionality — including per-source lexical +
vector retrieval, reciprocal rank fusion, the `updated_at` recency blend, the retrieval eval
harness and the per-generation `retrieval` record — lives in
`packages/website/docs/modules/knowledge.md`.

| Component                              | Status    | Notes                                                                                                           |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| Entity graph queries                   | ❌ Future | `entity_ids`, `entity_names`, `actor_ids` filters; `resolveEntitySearch()` (depends on prd-memories.md Phase 6) |
| Hybrid vector + entity search          | ❌ Future | Entity filter narrows candidates, vector search ranks within                                                    |
| Graph traversal queries                | ❌ Future | `predicate` and `direction` filters for edge-based traversal                                                    |
| Reranking stage                        | ❌ Future | Optional cross-encoder/LLM rerank of fused candidates (Phase 5)                                                 |
| Importance and reaffirmation weighting | ❌ Future | Memory blend on prd-memories.md Phase 8 columns (Phase 5)                                                       |
| Memory-pipeline evals                  | ❌ Future | Multi-session recall, contradiction handling, point-in-time recall — end to end through a memory rule (Phase 7) |
| Point-in-time retrieval                | ❌ Future | `as_of` on knowledge search and on memory listing (Phase 8)                                                     |

## Implementation Phases

### Phase 3 — Entity Graph Queries ❌ Future

> **Demand-gated.** This phase builds only when both roadmap gates fire — a
> measured hybrid-retrieval gap on the golden set, plus observed user
> demand. The gates, the cheaper fallback, and the rationale live in
> [roadmap.md](./roadmap.md#entity-graph-memories-phase-6--knowledge-phase-3--demand-gated);
> a finished design here is not a green light.

**Goal:** Extend `searchKnowledge()` with entity-based filters so callers can query knowledge by structured graph traversal — not just vector similarity. Enables precise queries like "everything about Pedro", "what does Company X own?", and "all knowledge linked to actor `act_01`".

**Dependencies:** Memory entity graph layer (prd-memories.md Phase 6) must be complete.

**New parameters on `POST /api/v1/knowledge/search`:**

| Parameter      | Type     | Description                                                                                |
| -------------- | -------- | ------------------------------------------------------------------------------------------ |
| `entity_ids`   | string[] | Filter memories linked to these entity IDs (`mey_...`)                                     |
| `entity_names` | string[] | Filter memories linked to entities matching these names (case-insensitive substring match) |
| `actor_ids`    | string[] | Filter memories linked to entities that have these actor IDs (`act_...`)                   |
| `entity_types` | string[] | Filter memories linked to entities of these types (`person`, `organization`, etc.)         |
| `predicate`    | string   | Filter by canonical predicate (the verb: `owns`, `works_at`, `prefers`)                    |
| `direction`    | string   | Filter by the matched entity's side of the edge: `subject` (doer) or `object` (receiver)   |

All entity parameters are optional and compose with existing vector/memory/document filters.

**Query modes:**

| Mode              | Parameters                               | Behavior                                                        |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------- |
| Hybrid (existing) | `query`                                  | Lexical + vector across all sources, fused                      |
| Entity-only       | `entity_ids` or `entity_names`           | All memories linked to those entities, ordered by `updated_at`  |
| Actor-only        | `actor_ids`                              | All memories linked to entities mapped to those actors          |
| Hybrid + entity   | `query` + entity filters                 | Entity filter narrows candidate set, hybrid search ranks within |
| Graph traversal   | `entity_ids` + `predicate`               | Follow specific relationships from an entity                    |
| Full graph        | `entity_ids` + `predicate` + `direction` | Directed edge traversal                                         |

**Deliverables:**

- `resolveEntitySearch()` lib function in `knowledge.ts` — resolves entities by ID/name/actor, follows `MemoryEntityEdge` edges (optionally filtered by `predicate` / `direction`), and maps matched edges to their provenance memories
- Entity filters compose with memory filters: entity match narrows the memory set, store/tag filters narrow the store scope; intersection of both
- When `query` is provided alongside entity filters: entity match produces candidate memories, then hybrid search ranks them
- When `query` is absent and only entity filters are provided: return all matching memories ordered by `updated_at` descending (no ranking needed)
- `predicate` and `direction` filters applied on `MemoryEntityEdge` — only memories that assert the specified edge; only currently-valid (non-invalidated) edges are followed
- **Single-hop only:** the surface follows edges one hop from the matched entities to memories. Multi-hop path queries ("how are Pedro and Company X related?") are explicitly out of scope for this phase
- Response enrichment: memory-type results include an `entities` array showing linked entities and their edge predicates
- OpenAPI spec updated → SDK/CLI regenerated → `search-knowledge` soat-tool gains entity parameters automatically
- Tests: entity-only search, actor-only search, hybrid + entity, relationship traversal, direction filtering, entity + store scope intersection

**Example queries:**

```jsonc
// "What do we know about Pedro?"
{ "project_id": "proj_01", "entity_names": ["Pedro"] }

// "What does Pedro own?" (graph traversal)
{ "project_id": "proj_01", "entity_names": ["Pedro"], "predicate": "owns", "direction": "subject" }

// "Everything about actor act_01" (actor-anchored)
{ "project_id": "proj_01", "actor_ids": ["act_01"] }

// "Pedro-related memories that mention billing" (hybrid: entity narrows, search ranks)
{ "project_id": "proj_01", "query": "billing", "entity_names": ["Pedro"] }

// "All people connected to Company X"
{ "project_id": "proj_01", "entity_names": ["Company X"], "entity_types": ["person"] }

// "Actor act_01 relationships in CRM stores only" (entity + store scope)
{ "project_id": "proj_01", "actor_ids": ["act_01"], "tags": { "domain": "crm" } }
```

**Unlocks:** Phase 6c of the Memory module (entity-based knowledge queries). Agents can answer structured questions about entities and relationships using the same `search-knowledge` tool.

---

### Phase 5 — Rerank and Importance Weighting ❌ Future

**Goal:** Re-score the top fused candidates against the query, and weight memory results by how
important they are and how recently they were reaffirmed. Per-source lexical + vector retrieval,
reciprocal rank fusion and the `updated_at` recency blend ship (module docs).

**Deliverables:**

- Optional rerank stage: `rerank: true` re-scores the top fused candidates against the query with
  a cross-encoder or LLM scorer before the final cut — off by default (latency/cost)
- Memory blend: the recency factor measures age from the later of `updated_at` and
  `last_reaffirmed_at`, and `importance` multiplies the fused score (`null` counts as 0.5), both
  from prd-memories.md Phase 8. Document results are unaffected. Use counts stay out of ranking —
  see prd-memories.md Phase 8
- Every ranking change lands with before/after golden-set numbers

**Acceptance criteria:**

- [ ] **Rerank API shape:** `rerank: true` re-scores the top fused candidates before the final cut. Input: the query plus the candidate list — `{ query: string, candidates: [{ id, content }] }` (top-N fused, default N = 20, configurable). Output: reordered ids with scores — `[{ id, score }]`, descending. Off by default; the added latency/cost is documented, and a rerank-stage failure degrades to the fused order instead of failing the request.
- [ ] **Importance and reaffirmation blend (memory only):** a memory restated by a `skipped` write decays from that restatement, not from its last edit; at equal fused score and age, higher `importance` ranks higher. Document results are unaffected.
- [ ] **No API break:** same endpoint; all new parameters additive and optional.
- [ ] **Regression gate:** the change lands with before/after golden-set numbers (recall@k, MRR) showing no regression at recall@10.

**Unlocks:** Better ranking for both RAG and memory recall with no API break — same endpoint.

---

### Phase 7 — Memory-Pipeline Evals ❌ Future

**Goal:** Measure the memory write path, which the retrieval eval cannot see. The retrieval
harness ships (`packages/server/tests/eval/knowledge`: a golden set of 58 queries across exact
token, exact name, entity, semantic and freshness kinds; recall@5, recall@10 and MRR against a
pinned baseline; the `knowledge-eval` CI job), and each generation records what retrieval injected
(`retrieval`). Both score a corpus seeded directly, so neither exercises extraction, supersede or
invalidation.

**Deliverables:**

- Scenarios exercised end to end — memory rule → write → search:
  - **Multi-session recall:** a fact learned in one conversation is retrieved in a later one.
  - **Contradiction handling:** a later contradicting fact retires the earlier one — through the
    thresholds, a declared `supersedes`, and the arbiter once prd-memories.md 5b lands.
  - **Point-in-time recall:** `as_of` (Phase 8) returns what the store held at T.
- Deterministic in CI: a tool handler with scripted facts stands in for the extractor model, so the
  score measures the pipeline, not a model.
- Numbers reported beside the retrieval eval's, against a pinned baseline.

**Acceptance criteria:**

- [ ] At least one scenario per kind, runnable with the eval command and deterministic across runs.
- [ ] prd-memories.md 5b (arbitration) lands with before/after numbers on the contradiction
      scenarios and no regression on the others.

**Unlocks:** Contradiction handling and temporal recall become regression-tested properties
instead of a vibe.

---

### Phase 8 — Point-in-Time Retrieval ❌ Future

**Goal:** Answer "what did the store hold at T" — the state an agent answered from, not today's.
Supersede and retraction keep every retired memory readable; nothing queries them by time.

**Deliverables:**

- `as_of` (date-time) on `POST /api/v1/knowledge/search` and `GET /api/v1/memories`. A memory is
  returned when it was valid at T: created at or before T and not invalidated at T. A memory
  retired and later restored is invalid between the two; the assertion ledger holds every validity
  change, so the interval is recoverable.
- **Ingestion time, not world time:** T is when the store learned and retired facts, not when they
  were true in the world.
- Memory results only; document results are searched at their current version.
- Deleted and purged memories are absent at every T.
- With `as_of`, the recency blend measures age at T.

**Acceptance criteria:**

- [ ] A memory superseded at t1 is returned for `as_of` < t1 and not for `as_of` ≥ t1; its
      replacement the other way round.
- [ ] A memory retracted at t1 and restored at t2 is absent for `as_of` in [t1, t2) and returned
      otherwise.
- [ ] Without `as_of`, results are unchanged.

**Unlocks:** "Why did the agent say that last month?" is answerable from the store itself.

## Implementation Architecture

### Planned additions

```
src/lib/knowledge.ts
├── resolveEntitySearch()      — Phase 3: entity/actor lookup → edge traversal → provenance memory IDs
└── enrichEntityMetadata()     — Phase 3: attach linked entities to memory-type results

src/lib/knowledgeRanking.ts
├── importance + reaffirmation blend — Phase 5
└── optional rerank stage            — Phase 5

src/lib/knowledgeMemory.ts
└── as_of validity filter      — Phase 8
```

Entity graph filters query `MemoryEntity` + `MemoryEntityEdge` (from the memory module) — Phase 3, depends on prd-memories.md Phase 6.
