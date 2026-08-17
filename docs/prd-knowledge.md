# PRD: Knowledge Module

## Implementation Status

Only outstanding work is tracked here; shipped functionality lives in `packages/website/docs/modules/knowledge.md`.

| Component                          | Status         | Notes                                                                                            |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| Entity graph queries               | ❌ Future      | `entity_ids`, `entity_names`, `actor_ids` filters; `resolveEntitySearch()` (depends on prd-memories.md Phase 6) |
| Hybrid vector + entity search      | ❌ Future      | Entity filter narrows candidates, vector search ranks within                                     |
| Graph traversal queries            | ❌ Future      | `predicate` and `direction` filters for edge-based traversal                                     |
| Hybrid lexical + vector search     | ❌ Future      | `tsvector`/BM25 alongside pgvector per source (Phase 5)                                          |
| RRF result merging                 | ❌ Future      | Reciprocal rank fusion replaces raw-score interleave across sources (Phase 5)                    |
| Reranking stage                    | ❌ Future      | Optional cross-encoder/LLM rerank of fused candidates (Phase 5)                                  |
| Recency/importance weighting       | ❌ Future      | Retrieval-time blend for memory results (Phase 5; importance from prd-memories.md Phase 8)       |
| Evaluation harness                 | ❌ Future      | Golden query set, recall@k/MRR, memory benchmarks, injected-context tracing (Phase 7)            |
| `knowledge_config` single-casing   | 🟠 Decided — pre-v1 | Backfill pre-single-casing agent rows, replace the deep key transform with explicit per-field mapping, delete the dead `query` fallback (#1063; see [Engine Review Findings](#engine-review-findings-2026-08)) |

## Engine Review Findings — Resolved by Removal (#1063)

Two pieces of the shipped `knowledge_config` surface were removed pre-v1. Neither
changed the wire contract; both got strictly more expensive to do later.

| Finding | Resolution |
| --- | --- |
| **Deep case transform on `knowledge_config`** — `normalizeKnowledgeConfig` / `denormalizeKnowledgeConfig` rewrote every key in the bag recursively, the key-walking shape `.claude/rules/case-convention.md` bans after #651/#690/#729/#737 | ✅ Removed. The bag is stored in the wire casing verbatim (`toStoredKnowledgeConfig`) and read into the engine's camelCase shape field by field (`readKnowledgeConfig`). Rows persisted before single-casing are normalized once at boot by `backfillKnowledgeConfigCasing`, covering both `agents.knowledge_config` and the `config.knowledge_config` on version snapshots. `convertKeysDeep` is deleted — it had no other caller. |
| **Dead `knowledge_config.query` fallback** — in the TS type and in `buildKnowledgeMessages`, but in no OpenAPI schema, so `strictFields` rejected it on every REST request and the formation validator rejected it in templates | ✅ Removed. The query is the turn's own last user message; a generation with no user-role string content injects knowledge only when the config carries explicit filters. If a stored-query use case materializes it returns as a specced field with a documented contract. |

This unblocks the pluggable-algorithm work: `knowledge_config` may now grow a
field that holds user-authored keys (a per-algorithm config map), which the deep
transform would have corrupted.

## Implementation Phases

### Phase 3 — Entity Graph Queries ❌ Future

> **Demand-gated.** This phase builds only when both roadmap gates fire — a
> measured hybrid-retrieval gap on the Phase 7 golden set, plus observed user
> demand. The gates, the cheaper fallback, and the rationale live in
> [roadmap.md](./roadmap.md#entity-graph-memories-phase-6--knowledge-phase-3--demand-gated);
> a finished design here is not a green light.

**Goal:** Extend `searchKnowledge()` with entity-based filters so callers can query knowledge by structured graph traversal — not just vector similarity. Enables precise queries like "everything about Pedro", "what does Company X own?", and "all knowledge linked to actor `act_01`".

**Dependencies:** Memory source integration (shipped) must be in place. Memory entity graph layer (prd-memories.md Phase 6) must be complete.

**New parameters on `POST /api/v1/knowledge/search`:**

| Parameter      | Type     | Description                                                                               |
| -------------- | -------- | ----------------------------------------------------------------------------------------- |
| `entity_ids`   | string[] | Filter entries linked to these entity IDs (`mey_...`)                                     |
| `entity_names` | string[] | Filter entries linked to entities matching these names (case-insensitive substring match) |
| `actor_ids`    | string[] | Filter entries linked to entities that have these actor IDs (`act_...`)                   |
| `entity_types` | string[] | Filter entries linked to entities of these types (`person`, `organization`, etc.)         |
| `predicate`    | string   | Filter by canonical predicate (the verb: `owns`, `works_at`, `prefers`)                   |
| `direction`    | string   | Filter by the matched entity's side of the edge: `subject` (doer) or `object` (receiver)  |

All entity parameters are optional and compose with existing vector/memory/document filters.

**Query modes:**

| Mode                   | Parameters                                  | Behavior                                                        |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Vector-only (existing) | `query`                                     | Cosine similarity across all sources                            |
| Entity-only            | `entity_ids` or `entity_names`              | All entries linked to those entities, ordered by `updated_at`   |
| Actor-only             | `actor_ids`                                 | All entries linked to entities mapped to those actors           |
| Hybrid (vector+entity) | `query` + entity filters                    | Entity filter narrows candidate set, vector search ranks within |
| Graph traversal        | `entity_ids` + `predicate`                  | Follow specific relationships from an entity                    |
| Full graph             | `entity_ids` + `predicate` + `direction`    | Directed edge traversal                                         |

**Deliverables:**

- `resolveEntitySearch()` lib function in `knowledge.ts` — resolves entities by ID/name/actor, follows `MemoryEntityEdge` edges (optionally filtered by `predicate` / `direction`), and maps matched edges to their provenance entries
- Entity filters compose with memory filters: entity match narrows the entry set, memory/tag filters narrow the memory scope; intersection of both
- When `query` is provided alongside entity filters: entity match produces candidate entries, then vector similarity ranks them
- When `query` is absent and only entity filters are provided: return all matching entries ordered by `updated_at` descending (no ranking needed)
- `predicate` and `direction` filters applied on `MemoryEntityEdge` — only entries that assert the specified edge; only currently-valid (non-invalidated) edges are followed
- **Single-hop only:** the surface follows edges one hop from the matched entities to entries. Multi-hop path queries ("how are Pedro and Company X related?") are explicitly out of scope for this phase
- Response enrichment: memory-type results include an `entities` array showing linked entities and their edge predicates
- OpenAPI spec updated → SDK/CLI regenerated → `search-knowledge` soat-tool gains entity parameters automatically
- Tests: entity-only search, actor-only search, hybrid vector+entity, relationship traversal, direction filtering, entity+memory scope intersection

**Example queries:**

```jsonc
// "What do we know about Pedro?"
{ "project_id": "prj_01", "entity_names": ["Pedro"] }

// "What does Pedro own?" (graph traversal)
{ "project_id": "prj_01", "entity_names": ["Pedro"], "predicate": "owns", "direction": "subject" }

// "Everything about actor act_01" (actor-anchored)
{ "project_id": "prj_01", "actor_ids": ["act_01"] }

// "Pedro-related entries that mention billing" (hybrid: entity narrows, vector ranks)
{ "project_id": "prj_01", "query": "billing", "entity_names": ["Pedro"] }

// "All people connected to Company X"
{ "project_id": "prj_01", "entity_names": ["Company X"], "entity_types": ["person"] }

// "Actor act_01 relationships in CRM memories only" (entity + memory scope)
{ "project_id": "prj_01", "actor_ids": ["act_01"], "memory_tags": ["crm"] }
```

**Unlocks:** Phase 6c of the Memory module (entity-based knowledge queries). Agents can answer structured questions about entities and relationships using the same `search-knowledge` tool.

---

### Phase 5 — Hybrid Retrieval and Ranking ❌ Future

**Goal:** Close the retrieval-quality gap with current practice: hybrid lexical + vector search
per source, rank fusion across sources, an optional rerank stage, and recency/importance weighting
for memory entries.

**Motivation:** Ranking today is single-signal — cosine similarity against one embedding, merged
across sources by raw score. Three problems:

1. **Vector-only search misses exact terms.** Identifiers, names, error codes, and rare tokens
   ("SKU-4711") are lexical lookups; embeddings blur them. Hybrid BM25 + vector is the standard
   baseline, and Postgres provides `tsvector` almost for free.
2. **Raw-score interleave across sources is statistically wrong.** Document chunks and atomic
   memory facts have different length and score distributions — one merged list sorted by raw
   cosine systematically favors one source. Rank-based fusion (RRF) merges heterogeneous lists
   without comparing raw scores.
3. **Memory has a time dimension documents don't.** A fact's usefulness decays; score-only ranking
   returns stale facts above fresh ones.

**Deliverables:**

- Lexical search per source: `tsvector` (`websearch_to_tsquery`) over `DocumentChunk.content` and
  `MemoryEntry.content`, run in parallel with the existing pgvector queries
- **Reciprocal rank fusion** replaces the raw-score interleave in the merge step: each
  source × signal list (memory-vector, memory-lexical, document-vector, document-lexical)
  contributes rank-based scores; the shipped `score` field — already documented as an
  implementation-defined ranking, and cosine-valued until this phase — becomes the fused score,
  with the raw cosine still returned as `similarity_score` for debugging
- Optional rerank stage: `rerank: true` re-scores the top fused candidates against the query with
  a cross-encoder or LLM scorer before the final cut — off by default (latency/cost)
- Recency/importance blend for memory results: fused rank × `updated_at` recency decay × entry
  `importance` (once prd-memories.md Phase 8 lands)
- `min_score` semantics re-documented against the fused score; defaults recalibrated
- Every ranking change lands with before/after numbers from the Phase 7 golden set

**Acceptance criteria:**

- [ ] **Lexical recall:** a search for an exact rare token (e.g. `"SKU-4711"`) returns the chunk/entry containing it even when its cosine similarity alone would miss the cut — implemented via `websearch_to_tsquery` `tsvector` queries over `DocumentChunk.content` and `MemoryEntry.content`, run in parallel with the pgvector queries.
- [ ] **RRF fusion pinned:** merged `score` is computed as `Σ 1 / (k + rank_i)` over the ranked lists a result appears in, with **`k = 60` as the default** (the literature default), configurable (e.g. an `rrf_k` request field or server-level default). A result appearing in more lists ranks higher, all else equal.
- [ ] **Four fusion inputs** when both signals and both sources apply: document-vector, document-lexical, memory-vector, memory-lexical. Raw cosine is still returned per result as the shipped `similarity_score` field for debugging; `score` is the fused value.
- [ ] **Rerank API shape:** `rerank: true` re-scores the top fused candidates before the final cut. Input: the query plus the candidate list — `{ query: string, candidates: [{ id, content }] }` (top-N fused, default N = 20, configurable). Output: reordered ids with scores — `[{ id, score }]`, descending. Off by default; the added latency/cost is documented, and a rerank-stage failure degrades to the fused order instead of failing the request.
- [ ] **Recency/importance blend (memory only):** memory results' fused score is blended with an `updated_at` recency decay (configurable half-life, sane default documented) and — once prd-memories.md Phase 8 lands — entry `importance`. Document results are unaffected.
- [ ] **No API break:** same endpoint; all new parameters additive and optional. `min_score` documented against the fused score with recalibrated defaults.
- [ ] **Regression gate:** the change lands with before/after Phase 7 golden-set numbers (recall@k, MRR) showing no regression at recall@10.

**Unlocks:** Materially better retrieval for both RAG and memory recall with no API break — same
endpoint, better ranking.

---

### Phase 7 — Evaluation Harness and Observability ❌ Future

**Goal:** Make "the retrieval is good" measurable. Neither the memory nor the knowledge module
defines success metrics today, and ranking changes (Phase 5) need a regression gate.

**Deliverables:**

- Golden-set harness: seed a project with fixture documents and memories, run a curated query set,
  score **recall@k / MRR / nDCG** against labeled expected results — runnable locally and in CI
- Memory-pipeline evals modeled on long-horizon memory benchmarks (LongMemEval-style):
  multi-session fact recall, contradiction/update handling, and temporal reasoning over superseded
  facts, exercised end-to-end through extraction → write → search
- Injected-context observability: record what `buildKnowledgeMessages()` injected per generation
  (source IDs, scores, byte size) on the generation's trace, so "why did the agent say this" is
  answerable from the traces module
- Baseline numbers published in the module docs; Phase 5 ranking changes must show wins on the
  golden set before landing

**Acceptance criteria:**

- [ ] **Golden set size:** **≥ 50 query/expected-result pairs**, seeded from real module docs
      (`packages/website/docs/modules/*.md` ingested as fixture documents) plus curated memory
      entries; labels stored in-repo and versioned alongside the harness.
- [ ] **Metrics reported:** **recall@k** (at minimum k = 5 and k = 10) and **MRR** on every run;
      nDCG additionally where graded relevance labels exist.
- [ ] **Runnable locally and in CI** with a single command; deterministic across runs (pinned
      embedding model or fixture embeddings).
- [ ] **Memory-pipeline evals:** at least one scenario each for multi-session fact recall,
      contradiction/update handling, and temporal reasoning over superseded facts — exercised
      end-to-end through extraction → write → search.
- [ ] **Injected-context observability:** each generation's trace records what
      `buildKnowledgeMessages()` injected — source IDs, scores, byte size — queryable via the
      traces module.
- [ ] **Regression gate wired:** baseline numbers published in the module docs; a Phase 5 ranking
      change cannot land without before/after golden-set numbers and no recall@10 regression.

**Unlocks:** Retrieval quality becomes a regression-tested property instead of a vibe.

## Engine Review Findings (2026-08)

From the 2026-08-17 code-level review of the shipped engine (memory-side findings live in
[prd-memories.md](./prd-memories.md#engine-review-findings-2026-08); sequencing stays in
[roadmap.md](./roadmap.md)).

### `knowledge_config` still rides a deep key transform

`normalizeKnowledgeConfig` / `denormalizeKnowledgeConfig` (`agentKnowledge.ts`) recursively
rewrite every key in the bag between casings — the exact shape
`.claude/rules/case-convention.md` bans, and the `knowledge_config` casing family already
produced #524. The exception is deliberately argued at the definition site: the bag carries only
engine-owned keys and no free-form value maps, so the transform never touches a key it does not
own. The *live* reason it survives is compatibility with agent rows persisted before
single-casing, when request middleware camelCased the bag before storage.

Durable fix, in order: a one-time backfill migration normalizing stored `knowledge_config`
values to a single casing; then replace the transform with the explicit field-by-field mapping
the rest of the wire uses; then delete `convertKeysDeep` from this path. This should land
**before** `knowledge_config` grows any field that can hold user-authored keys (a future
retrieval-options block, per-algorithm config maps) — such a field silently breaks the
"no free-form value maps" premise the current exception rests on, which is exactly the failure
class (#651, #690, #729, #737) the case-convention rule exists to prevent.

> **Decision (2026-08-17): sequenced pre-v1 (#1063)**, together with removing the dead
> `knowledge_config.query` fallback (in the TS type only — no OpenAPI schema carries it, so
> `strictFields` and the formation validator both reject it; unreachable from every wire
> surface). Neither changes the wire contract; both get strictly more expensive with every
> stored row and every new `knowledge_config` field, and the transform's removal is what
> clears `knowledge_config` to carry per-algorithm config later.

## Implementation Architecture

### Planned state (after entity integration — Phase 3)

```
src/lib/knowledge.ts (additions)
├── resolveEntitySearch()      — private: entity/actor lookup → edge traversal → provenance entry IDs
├── enrichEntityMetadata()     — private: attach linked entities to memory-type results
└── mergeAndRank()             — private: combine + sort (by score or updated_at) + filter results
                                 (Phase 5: RRF fusion + recency/importance blend + optional rerank)
```

Entity graph filters query `MemoryEntity` + `MemoryEntityEdge` (from the memory module) — Phase 3, depends on prd-memories.md Phase 6.
