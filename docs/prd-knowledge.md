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
| Injection hardening                | ❌ Future      | Retrieved knowledge injected as delimited non-system content (Phase 6)                           |
| Evaluation harness                 | ❌ Future      | Golden query set, recall@k/MRR, memory benchmarks, injected-context tracing (Phase 7)            |

## Implementation Phases

### Phase 3 — Entity Graph Queries ❌ Future

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
  contributes rank-based scores; the response `score` becomes the fused score, with the raw cosine
  still returned as `similarity` for debugging
- Optional rerank stage: `rerank: true` re-scores the top fused candidates against the query with
  a cross-encoder or LLM scorer before the final cut — off by default (latency/cost)
- Recency/importance blend for memory results: fused rank × `updated_at` recency decay × entry
  `importance` (once prd-memories.md Phase 8 lands)
- `min_score` semantics re-documented against the fused score; defaults recalibrated
- Every ranking change lands with before/after numbers from the Phase 7 golden set

**Acceptance criteria:**

- [ ] **Lexical recall:** a search for an exact rare token (e.g. `"SKU-4711"`) returns the chunk/entry containing it even when its cosine similarity alone would miss the cut — implemented via `websearch_to_tsquery` `tsvector` queries over `DocumentChunk.content` and `MemoryEntry.content`, run in parallel with the pgvector queries.
- [ ] **RRF fusion pinned:** merged `score` is computed as `Σ 1 / (k + rank_i)` over the ranked lists a result appears in, with **`k = 60` as the default** (the literature default), configurable (e.g. an `rrf_k` request field or server-level default). A result appearing in more lists ranks higher, all else equal.
- [ ] **Four fusion inputs** when both signals and both sources apply: document-vector, document-lexical, memory-vector, memory-lexical. Raw cosine is still returned per result as `similarity` for debugging; `score` is the fused value.
- [ ] **Rerank API shape:** `rerank: true` re-scores the top fused candidates before the final cut. Input: the query plus the candidate list — `{ query: string, candidates: [{ id, content }] }` (top-N fused, default N = 20, configurable). Output: reordered ids with scores — `[{ id, score }]`, descending. Off by default; the added latency/cost is documented, and a rerank-stage failure degrades to the fused order instead of failing the request.
- [ ] **Recency/importance blend (memory only):** memory results' fused score is blended with an `updated_at` recency decay (configurable half-life, sane default documented) and — once prd-memories.md Phase 8 lands — entry `importance`. Document results are unaffected.
- [ ] **No API break:** same endpoint; all new parameters additive and optional. `min_score` documented against the fused score with recalibrated defaults.
- [ ] **Regression gate:** the change lands with before/after Phase 7 golden-set numbers (recall@k, MRR) showing no regression at recall@10.

**Unlocks:** Materially better retrieval for both RAG and memory recall with no API break — same
endpoint, better ranking.

---

### Phase 6 — Injection Hardening (Memory as Untrusted Input) ❌ Future

**Goal:** Stop laundering retrieved content into the `system` role. Extraction-sourced memory
entries are user-derived text; injecting them as system messages lets a user's phrasing acquire
system-level authority in **future** generations — a persistent prompt-injection escalation path
(say something once, and it comes back as a system instruction forever).

**Current behavior:** `buildKnowledgeMessages()` returns retrieved knowledge as a
`role: "system"` message prepended to the conversation.

**Deliverables:**

- Retrieved knowledge is injected as **clearly delimited, non-system content** (a user-role
  context block or provider-appropriate context part), explicitly framed as reference data —
  wrapped in delimiters with an instruction that the content inside is information, not
  instructions
- Source tags preserved inside the delimited block (`[Memory: …]`, `[Document: …]`), including
  provenance where available (entry ID, document path/page)
- The agent's own `instructions` remain the only system-authored content; a regression test
  asserts retrieved content is never emitted with `role: "system"`
- Memory threat model documented: extraction already runs tool-less (no side effects); retrieved
  memory content must be treated as untrusted in downstream tool authorization

**Acceptance criteria:**

- [ ] **No system-role laundering:** a regression test asserts that no message produced by
      `buildKnowledgeMessages()` is emitted with `role: "system"`, covering every injection path
      (agent `knowledge_config`, per-generation `knowledge_config`, conversations and sessions).
- [ ] **Delimited block format pinned:** retrieved content is wrapped in explicit delimiters with a
      fixed preamble stating the enclosed content is reference information, not instructions; the
      exact delimiter/preamble text is documented in the module docs so it is testable and stable.
- [ ] **Provenance preserved:** source tags survive inside the block — `[Memory: <name>]` with the
      entry ID, `[Document: <path>]` with page where available — verified by test.
- [ ] **Single system author:** a generation configured with both agent `instructions` and retrieved
      knowledge produces exactly one system-authored message containing only the instructions.
- [ ] **Threat model documented** in the module docs: extraction runs tool-less; retrieved memory
      content is untrusted input for downstream tool authorization.
- [ ] **No quality regression:** Phase 7 golden-set numbers before/after the injection change show
      no material retrieval/answer regression.

**Unlocks:** Memory and RAG that don't widen the prompt-injection blast radius.

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
