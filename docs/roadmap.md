# SOAT v1 Roadmap

The single roadmap for shipping **SOAT v1**. It defines what ships in v1 point
releases after the release candidate (RC) and what is explicitly post-v1. The
RC blocker list is done — see the Decision record. Shipped functionality is not
tracked here — live behavior is documented in the website module docs
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

**No open item fails that test.** The five RC blockers shipped in 2026-08 (see
the Decision record); everything below is additive. Keep the test to hand for
judging new proposals, not for the list that remains.

## Legend

| Marker | Meaning |
|--------|---------|
| 🟠 | v1.x — ships in a point release after the RC |
| ⏭️ | Post-v1 / deferred — gated on demand or on another initiative |

---

## 🔴 Pre-v1 — contract removals (block the release)

The inverse of the v1 test: these **cannot** be done after v1 without breaking
the frozen contract, so they must land before it. Decided 2026-08 from the
engine review (#1061); breaking pre-v1 is accepted.

- [ ] **Remove the concatenation merge and the unread actor memory link**
      (#1062) — no path concatenates (merge band without a consolidation
      context creates; consolidation-failure fallback creates);
      `update_threshold` leaves the wire (5a reintroduces it as
      `shortlist_threshold`); `actors.memory_id` / `auto_create_memory` removed
      end to end (model, REST, formations, docs). Actor-scoped retrieval
      returns post-v1, server-side, via the entity-graph fallback.
- [ ] **Remove the `knowledge_config` deep case transform and the dead `query`
      fallback** (#1063) — not contract-breaking (internal representation +
      a one-time backfill of stored rows), but sequenced here by decision:
      the backfill grows with every deployment, and deleting the transform is
      what clears `knowledge_config` to carry per-algorithm config safely.

## 🟠 v1.x — after the RC, inside the v1 line

All additive; none changes a frozen field or loses data by waiting.

**Suggested v1.x order:** memories P7 (streaming extraction) → knowledge P7
(eval harness) → memories 5a (arbitration) → knowledge P5 (ranking). Memories
P7 goes first because 5a improves write quality for traffic that is already
captured, while P7 makes passive memory exist at all for the dominant
transport — a user who enables extraction and sees nothing captured concludes
the feature is broken. P7 has no dependency on 5a; the trade-off (streaming
traffic captured before 5a lands goes through the v1 merge path) is acceptable
because the invalidation schema is already in place and 5a changes behavior,
not stored data.

### Memories

- [ ] **Phase 7 — extraction coverage for streaming, `requires_action`, and
      background (`wait=false`) direct completions.** No API change, but the
      passive-memory pipeline currently misses streaming (the dominant
      production transport) and the direct-generation background path — the
      highest-value post-RC item. Until it lands, the docs must not claim
      extraction covers streaming.
- [ ] **5a — LLM-arbitrated write decision.** Top-K shortlist +
      add/update/supersede/skip arbitration; v1 fallback semantics on LLM
      failure; consolidation for the manual REST write path. Internal write
      behavior on top of the shipped invalidation schema — the `action` enum
      already includes `superseded`, so no contract change.

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
      rerank stage, recency blend. Additive parameters only; `score` already
      ships as an implementation-defined ranking, so refilling it with a fused
      value is not a contract change. Must land with before/after Phase 7
      golden-set numbers and no recall@10 regression.

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

Technical dependencies (unchanged): memories 5a (supersede must invalidate
edges; the schema it populates already ships) and Knowledge Phase 7 (the
evidence gate's measurement) landing first.

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
v1.x ───────────────────────────────────────────────────────────
  memories P7 (streaming extraction) — first
  knowledge P7 (eval harness) ──► knowledge P5 (ranking; needs the gate)
  memories 5a (arbitration)  ◄── invalidation schema ✔ shipped

post-v1 ────────────────────────────────────────────────────────
  memories P6 (entity data) ◄──► knowledge P3 (entity queries)
      ▲ needs 5a (supersede invalidates edges)
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
- **v1 RC blockers complete (2026-08)** — memory entry provenance, temporal
  invalidation schema + `include_invalidated` / `superseded` API shape,
  `score` as an implementation-defined ranking beside the cosine-pinned
  `similarity_score`, the knowledge injection threat model in the module docs,
  and entry-id / page detail in the injected source tags all shipped (#1025,
  #1030, #1032). Nothing blocks cutting the RC. Live behavior is documented in
  the memories, knowledge and agents module docs; the blocker list itself is
  recoverable from this file's git history.
- **Entity graph demand-gated (2026-08)** — builds only on measured
  hybrid-retrieval gaps (Knowledge P7 golden set, structural queries) plus
  observed user demand; actor-scoped filtering on existing metadata is the
  fallback to try first. Rationale in the post-v1 section above.
