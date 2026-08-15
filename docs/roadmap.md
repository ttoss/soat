# SOAT v1 Roadmap

The single roadmap for shipping **SOAT v1**. It defines what must land before
the v1 release candidate (RC), what ships in v1 point releases after the RC,
and what is explicitly post-v1. Shipped functionality is not tracked here —
live behavior is documented in the website module docs
(`packages/website/docs/modules/`).

> **This is the only roadmap.** Sequencing lives here, not in the PRDs
> ([prd-memories.md](./prd-memories.md), [prd-knowledge.md](./prd-knowledge.md)).

## The v1 test

v1 freezes the public contract: REST bodies and fields, the OpenAPI specs (and
with them the SDK, CLI, and MCP tool surfaces), and the durability of stored
data. The gate for RC-blocking work is therefore not "is it valuable?" but:

> **Can this be added after v1 without breaking the frozen contract or losing
> data that cannot be backfilled?**

Only items that fail that test block the RC. Everything additive — new
endpoints, new optional parameters, internal ranking or pipeline changes —
ships after.

## Legend

| Marker | Meaning |
|--------|---------|
| 🔴 | RC blocker — must land before the v1 RC is cut |
| 🟠 | v1.x — ships in a point release after the RC |
| ⏭️ | Post-v1 / deferred — gated on demand or on another initiative |

---

## 🔴 RC blockers

### RC-1 — Memory entry provenance (Memories Phase 5c)

`sourceGenerationId` / `sourceConversationId` on `MemoryEntry`, populated by
the `write_memory` tool and the extraction write path, exposed as
`source_generation_id` / `source_conversation_id`.

**Why it blocks:** provenance cannot be backfilled — every entry created by a
v1 user before this lands is permanently unauditable
([prd-memories.md 5c](./prd-memories.md#5c--provenance): "ships early on
purpose"). Small change: two nullable FK columns plus mapper/spec/docs updates.

Note for implementation: there are **four** writers, not two — the manual REST
write and the orchestration memory-write node (`orchestrationNodeExecutors.ts`,
`sourceType: 'orchestration'`) carry null provenance by design (no generation
exists at either site). Name both explicitly in the tests so the null case is
asserted, not just implied.

### RC-2 — Temporal invalidation schema + API shape (Memories Phase 5b)

`invalidatedAt` + `supersededByEntryId` columns on `MemoryEntry`; the
`superseded` value in the write endpoint's `action` enum; the
`include_invalidated` query parameter on entry listing; invalidated entries
excluded from knowledge search, extraction dedup, and default listing.

**Why it blocks:** the columns share RC-1's backfill problem (supersede history
for the pre-v1 period is unrecoverable), and the API shape (`action` values,
`include_invalidated`) belongs in the frozen v1 contract rather than being
bolted on later. The **LLM arbitration that populates it (5a) does not block**
— it is internal write behavior and ships as v1.x (see below).

Note for implementation: until 5a lands, **no public API path sets
`invalidatedAt`** — the `superseded` action value and `include_invalidated`
parameter ship without a producer. The exclusion tests (knowledge search, dedup
shortlist, default listing) therefore cannot set up state through the API; seed
`invalidatedAt` via a direct model write in the test's `beforeAll`, justified
inline as the sanctioned exception ("no API producer until 5a"). Do not pull 5a
forward for the sake of the tests.

### RC-3 — Pin knowledge search `score` semantics as implementation-defined

Knowledge Phase 5 will introduce an RRF-fused relevance value and recalibrate
`min_score` defaults; if v1 freezes only today's cosine-named fields, that
later change either breaks `min_score` semantics or forces a second filter
parameter.

The shipped wire has **no `score` field**: results carry `similarity_score`
(documented as cosine similarity, 0–1) and requests carry `min_score`
(documented as a minimum similarity). An earlier version of this item said
"docs-only, re-document `score`" — that field does not exist, so the item is a
**minimal additive code change**, not docs-only.

**Deliverable:**

- Add `score` to both result variants in the OpenAPI spec and mappers — equal
  to the cosine value today — documented as an implementation-defined relevance
  ranking (higher is better, ordering is the contract, absolute values are
  not). Regenerate SDK/CLI.
- Keep `similarity_score` pinned as raw cosine similarity — its name asserts
  cosine semantics, so it must never be redefined; Phase 5 keeps returning it
  for debugging (the PRD's `similarity` field name aligns to `similarity_score`
  — do not introduce a third name).
- Re-document `min_score` as filtering on `score` under the
  implementation-defined caveat, defaults recalibratable by Phase 5.

### RC-4 — Knowledge injection threat model in the module docs

Move the security rationale out of the code comment in `agentKnowledge.ts` and
into the module docs: extraction runs tool-less, and retrieved memory content
is untrusted input for downstream tool authorization. A v1 user must be able to
read the platform's injection posture without reading source. (Second tail of
Knowledge Phase 6; the enforcement itself shipped.)

### RC-5 — Provenance detail in injected source tags

`[Memory: …]` tags carry the entry ID and `[Document: …]` tags carry the page,
not just the memory name and document path/filename. Grouped with the RC
because the rendered `<knowledge>` block format is documented verbatim in the
agents module doc — a v1 consumer may reasonably parse it, so changing the tag
format later is friction that is trivial to avoid now. (First tail of Knowledge
Phase 6.)

### RC checklist

- [x] RC-1 Memory entry provenance (5c) — #1025
- [x] RC-2 Temporal invalidation schema + `superseded` / `include_invalidated` API shape (5b) — #1025
- [x] RC-3 `score` documented as implementation-defined
- [x] RC-4 Threat model in module docs
- [x] RC-5 Entry-ID / page provenance in source tags — #1030

**The RC list is complete** — nothing here blocks cutting the v1 RC. Everything
below this line is additive and ships after it.

Suggested order: RC-1 and RC-2 together (one migration, one spec/docs pass over
the memories module), then RC-5, then RC-3 (small additive spec+code change)
and RC-4 (docs-only) in one PR.

---

## 🟠 v1.x — after the RC, inside the v1 line

All additive; none changes a frozen field or loses data by waiting.

**Suggested v1.x order:** memories P7 (streaming extraction) → knowledge P7
(eval harness) → memories 5a (arbitration) → knowledge P5 (ranking). Memories
P7 goes first because 5a improves write quality for traffic that is already
captured, while P7 makes passive memory exist at all for the dominant
transport — a user who enables extraction and sees nothing captured concludes
the feature is broken. P7 has no dependency on 5a; the trade-off (streaming
traffic captured before 5a lands goes through the v1 merge path) is acceptable
because RC-2's schema is already in place and 5a changes behavior, not stored
data.

### Memories

- [ ] **Phase 7 — extraction coverage for streaming and `requires_action`
      completions.** No API change, but the passive-memory pipeline currently
      misses streaming (the dominant production transport) — the highest-value
      post-RC item. Until it lands, the docs must not claim extraction covers
      streaming.
- [ ] **5a — LLM-arbitrated write decision.** Top-K shortlist +
      add/update/supersede/skip arbitration; v1 fallback semantics on LLM
      failure; consolidation for the manual REST write path. Internal write
      behavior on top of the RC-2 schema — the `action` enum already includes
      `superseded`, so no contract change.

### Knowledge

- [ ] **Phase 7 — evaluation harness & observability.** Golden query set
      (≥ 50 pairs), recall@k / MRR, memory-pipeline benchmarks,
      injected-context tracing. Baselines measured against the shipped
      non-system injection format. **Sequenced before Phase 5**, which needs it
      as a regression gate. The golden set must include exact-term and
      entity-style structural queries ("everything about <actor>", exact-name
      lookups) so Phase 5's before/after numbers double as the entity graph's
      evidence gate — without them, "does hybrid retrieval cover structural
      lookups?" stays unanswered by construction.
- [ ] **Phase 5 — hybrid retrieval & ranking.** `tsvector` lexical + pgvector
      per source, RRF fusion (replaces the raw-score interleave), optional
      rerank stage, recency blend. Additive parameters only; the `score`
      semantics change is pre-authorized by RC-3. Must land with before/after
      Phase 7 golden-set numbers and no recall@10 regression.

### G5 — usage metering refinement

- [ ] **Event-driven storage byte accounting** — replace the daily storage
      snapshot with incremental byte deltas on file/document mutation,
      eliminating intra-day sampling drift.

---

## ⏭️ Post-v1 / deferred

### Entity graph (Memories Phase 6 ↔ Knowledge Phase 3) — demand-gated

The largest pending initiative: `MemoryEntity` (`mey_`) + `MemoryEntityEdge`
models, async triple extraction on write, entity CRUD endpoints, and the
entity/actor/predicate search parameters on `POST /knowledge/search`. Memories
owns the data layer ([prd-memories.md Phase 6](./prd-memories.md#phase-6--entity-graph-layer--not-started));
knowledge owns the query surface
([prd-knowledge.md Phase 3](./prd-knowledge.md#phase-3--entity-graph-queries--future));
they ship together. Entirely additive — new models, new endpoints, new optional
parameters — so it gains nothing from being inside v1 and would delay the RC by
the most.

**Gates (both must fire before anything is built):**

1. **Evidence gate** — the Knowledge Phase 7 golden set includes structural
   queries ("everything about <actor>", exact-name lookups), and Phase 5
   hybrid retrieval (lexical + RRF) measurably fails them. If `tsvector`
   rescues exact-term recall, most of the graph's pitch is already served.
2. **Demand gate** — an actual user asking for relational queries, not an
   anticipated one.

**Cheaper fallback to try first:** actor-scoped entry filtering on existing
metadata — no triple extraction, no predicate normalization, no entity dedup
thresholds.

*Why gated, not just sequenced:* Phase 6's embedding-threshold entity dedup
reintroduces the exact failure mode Phase 5 (arbitration) exists to remove —
fixed cosine cutoffs making the decision — and its headline query ("how are X
and Y related?") is already out of scope (single-hop only). It is also the only
pending initiative that ships public API surface with unproven payoff, i.e. the
only real deprecation exposure on the roadmap. The go/no-go must rest on
measured retrieval gaps, not on the design being finished.

Technical dependencies (unchanged): RC-2/5a (supersede must invalidate edges)
and Knowledge Phase 7 (the evidence gate's measurement) landing first.

### Memories Phase 8 — forgetting

Importance scoring, access tracking, retrieval-time recency blend (delivered
through Knowledge Phase 5's ranking layer), retention policies with the
deterministic eviction order, and compaction. Additive columns and endpoints.

### Memories Phase 9 — profile memory

Always-injected bounded profile blocks, agent-editable. Still an explicit
sketch — requirements to be written before implementation.

### Deferred by design (demand-gated) — carried over unchanged

- [ ] ⏭️ **G3 Phase 5** — approver targeting & assignment (`approver_policy` /
      `assignees`); no demand signal yet
- [ ] ⏭️ **G3** — in-channel approval clients (WhatsApp/Slack) over the queue;
      the substrate (persist-then-webhook, platform-automatic continuation) is
      settled and any client-controlled continuation timing is scoped here
- [ ] ⏭️ **G6 learned rules** — semantic clustering, promotion lifecycle,
      scoped rule listing. Gates: sustained demand on the approvals recurrence
      view (open) **and** evaluations P1 (satisfied). Design record recoverable
      from git history (`docs/prd-learned-rules.md`, removed 2026-08)
- [ ] ⏭️ **Model routing** — per-consumer `model_route_id` on Chat (build only
      when two routes in one project is actually requested)
- [ ] **Model routing (accepted gap)** — failed attempts that burned tokens are
      not metered; visible via `routing.attempts`. Revisit only if a provider
      returns usage on error

---

## Dependency graph (pending nodes only)

```
RC ─────────────────────────────────────────────────────────────
  RC-1 provenance ┐
  RC-2 invalidation schema ┴─► one memories migration/spec pass
  RC-3 score semantics (docs)      RC-4 threat model (docs)
  RC-5 source-tag provenance

v1.x ───────────────────────────────────────────────────────────
  memories P7 (streaming extraction) — first
  knowledge P7 (eval harness) ──► knowledge P5 (ranking; needs the gate)
  memories 5a (arbitration)  ◄── RC-2 (schema it populates)

post-v1 ────────────────────────────────────────────────────────
  memories P6 (entity data) ◄──► knowledge P3 (entity queries)
      ▲ needs 5a/RC-2 (supersede invalidates edges)
      ⏭️ gates: hybrid-retrieval gap on P7 golden set (open) + demand (open)
  memories P8 (forgetting) ──► knowledge P5 recency/importance blend
  memories P9 (profile) — sketch
  learned rules ⏭️ ◄── recurrence-view demand (open) + evals P1 ✔
```

## Decision record (carried from the pre-v1 roadmap)

Resolved decisions that shape v1's surface; full rationale in git history of
this file:

- **Discussions removed at v0 (2026-08)** — deliberation is application-side
  context composition; primitives (agents, actors, conversations, documents)
  stay. Recoverable from git history if SOAT is ever asked to own deliberation
  as a governed artifact.
- **Context composition is the application's job (2026-07)** — knowledge
  packages / layered assembler dropped; SOAT injects via `instructions` and
  per-generation input messages.
- **Learned rules deferred (2026-07/08)** — exact-key recurrence shipped as the
  approvals recurrence view; module builds only if both gates fire.
- **`from-generation` dataset curation dropped (2026-08)** — operators curate
  client-side through the ordinary item-create route; revisit as an opt-in
  retention flag only on observed demand.
- **Activity vs audit split (2026-07)** — `ActivityEntry` owns agent/run
  telemetry; `AuditEntry` stays compliance-grade authorization events.
- **Entity graph demand-gated (2026-08)** — builds only on measured
  hybrid-retrieval gaps (Knowledge P7 golden set, structural queries) plus
  observed user demand; actor-scoped filtering on existing metadata is the
  fallback to try first. Rationale in the post-v1 section above.
