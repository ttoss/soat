# SOAT v1 Roadmap

The single roadmap for shipping **SOAT v1**. It defines what ships in v1 point
releases after the release candidate (RC) and what is explicitly post-v1.
Shipped functionality is not tracked here — live behavior is documented in the
website module docs (`packages/website/docs/modules/`), and past decisions live
in this file's git history, not in the file.

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

**One open item fails that test:** the values pending memory work adds to
shipped response enums, below. Everything else listed here is additive. Keep
the test to hand for judging new proposals.

### Open contract decision — new enum values

Memories 5a adds assertion `outcome: restored`; memories Phase 8 adds assertion
`mechanism: retention | compaction`. A client that switches over a frozen enum
breaks on a value it has never seen, so one of these must hold at the RC:

| Option       | Contract at the RC                                                                                                                      | Cost                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Reserve**  | The three values join the enums now, documented as not yet emitted                                                                      | The spec lists values no response carries until the phase ships, and fixes names before Phase 8's design settles |
| **Open set** | Both enums documented as an open set — clients must tolerate unknown values — as `orchestrations.yaml` does for node types and statuses | No value is promised ahead of time; every client handles one it does not know                                    |

Recommendation: open set. The ledger records which door a write came through,
and every new door is a new `mechanism`; reserving is worth it only when a
client must switch over the enum exhaustively. Waiting on a human decision.

## Legend

| Marker | Meaning |
|--------|---------|
| 🟠 | v1.x — ships in a point release after the RC |
| ⏭️ | Post-v1 / deferred — gated on demand or on another initiative |

---

## 🟠 v1.x — after the RC, inside the v1 line

All additive; none changes a frozen field or loses data by waiting.

**Suggested v1.x order:** memories P7 (rule-firing tests) → memories 5a
(restore, declared supersede for agents) → knowledge P7 (memory-pipeline
evals) → memories 5b (arbitration) → knowledge P5 (rerank). 5a precedes 5b
because 5b is the first step where a model retires facts unprompted: restore
is what undoes a wrong call, and the memory-pipeline evals measure how often
one happens. 5a's own model-driven path — an agent declaring `supersedes` —
is held to memories the agent was shown in that turn.

### Memories

- [ ] **Phase 7 — rule-firing tests.** `requires_action` and background
      (`wait=false`) direct generations fire memory rules through
      `generations.completed`; neither path has a test.
- [ ] **5a — restore, and declared supersede for agents.**
      `POST /memories/{memory_id}/restore`; optional `supersedes` on the
      `write_memory` tool and on the rule handler contract. A new endpoint and
      new optional fields; the `restored` outcome is the open decision above.
- [ ] **5b — LLM-arbitrated write decision.** Top-K shortlist +
      add/update/supersede/skip arbitration, with the arbiter set on the
      memory store; `update` lands as a supersede carrying the consolidated
      fact, so `action` keeps its three values. Threshold semantics on
      arbiter failure.

### Knowledge

- [ ] **Phase 7 — memory-pipeline evals.** Multi-session recall,
      contradiction handling and point-in-time recall, end to end through a
      memory rule, deterministic in CI. **Sequenced before memories 5b**,
      which needs the contradiction numbers as its gate.
- [ ] **Phase 5 — rerank.** Optional rerank stage over the fused candidates;
      an additive parameter. Must land with before/after golden-set numbers
      and no recall@10 regression. The importance blend waits on memories
      Phase 8.

### G5 — usage metering refinement

- [ ] **Event-driven storage byte accounting** — replace the daily storage
      snapshot with incremental byte deltas on file/document mutation,
      eliminating intra-day sampling drift. Also what would make the
      `storage_bytes` quota exact: the cap reads the last snapshot plus the
      request's own delta, so today it accepts up to a day of staleness.

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

1. **Evidence gate** — the knowledge golden set includes structural queries
   ("everything about <actor>", exact-name lookups), and hybrid retrieval
   (lexical + RRF) measurably fails them. **Not firing:** the retrieval
   baseline scores `entity` (12 queries) at recall@10 1.0 and MRR 0.958, and
   `exact_name` (15 queries) at recall@10 1.0. The golden set is synthetic and
   small; a structural query from real traffic that hybrid retrieval misses
   is evidence too.
2. **Demand gate** — an actual user asking for relational queries, not an
   anticipated one.

**Cheaper fallback to try first:** actor-scoped memory filtering on existing
metadata — no triple extraction, no predicate normalization, no entity dedup
thresholds.

*Why gated, not just sequenced:* Phase 6's embedding-threshold entity dedup
reintroduces the exact failure mode memories 5b (arbitration) exists to remove
— fixed cosine cutoffs making the decision — and its headline query ("how are
X and Y related?") is out of scope (single-hop only). It is also the only
pending initiative that ships public API surface with unproven payoff, i.e. the
only real deprecation exposure on the roadmap. The go/no-go must rest on
measured retrieval gaps, not on the design being finished.

Technical dependencies: memories 5b (an arbitrated supersede must invalidate
edges) and the knowledge golden set (the evidence gate's measurement) land
first.

### Memories Phase 8 — forgetting

Importance, use and reaffirmation tracking; retention (`max_memories`,
`ttl_days`) that retracts instead of deleting; a purge window for invalidated
memories, which keep counting toward storage until purged; compaction through
the 5b arbiter. Additive columns and endpoints, plus the `retention` and
`compaction` mechanisms in the open decision above.

### Memories Phase 9 — profile memory

Always-injected bounded profile blocks, one per actor, agent-editable. Still an
explicit sketch — requirements to be written before implementation.

### Knowledge Phase 8 — point-in-time retrieval

`as_of` on `POST /knowledge/search` and `GET /memories`: what a store held at
T, by ingestion time. An additive parameter over validity columns and a ledger
that already ship. Gated on the knowledge Phase 7 point-in-time scenario.

### Deferred by design (demand-gated)

- [ ] ⏭️ **G3 Phase 5** — approver targeting & assignment (`approver_policy` /
      `assignees`); no demand signal yet
- [ ] ⏭️ **G3** — in-channel approval clients (WhatsApp/Slack) over the queue;
      the substrate (persist-then-webhook, platform-automatic continuation) is
      settled and any client-controlled continuation timing is scoped here
- [ ] ⏭️ **G6 learned rules** — semantic clustering, promotion lifecycle,
      scoped rule listing. Gates: sustained demand on the approvals recurrence
      view (open) **and** evaluations P1 (satisfied). Design record recoverable
      from git history (`docs/prd-learned-rules.md`). A promoted rule spends
      the always-loaded instruction budget on every turn, so promotion needs a
      cap and a demotion path
- [ ] ⏭️ **Model routing** — per-consumer `model_route_id` on Chat (build only
      when two routes in one project is actually requested)
- [ ] **Model routing (accepted gap)** — failed attempts that burned tokens are
      not metered; visible via `routing.attempts`. Revisit only if a provider
      returns usage on error

---

## Dependency graph (pending nodes only)

```
before the RC ──────────────────────────────────────────────────
  enum decision: reserve | open set (restored, retention, compaction)

v1.x ───────────────────────────────────────────────────────────
  memories P7 (rule-firing tests) — first
  memories 5a (restore, declared supersede) ──► memories 5b (arbitration)
  knowledge P7 (memory-pipeline evals) ──► memories 5b (needs the gate)
  knowledge P5 (rerank)

post-v1 ────────────────────────────────────────────────────────
  memories P6 (entity data) ◄──► knowledge P3 (entity queries)
      ▲ needs 5b (an arbitrated supersede invalidates edges)
      ⏭️ gates: hybrid-retrieval gap on the golden set (not firing) + demand (open)
  memories P8 (forgetting) ──► knowledge P5 importance blend
      ▲ compaction needs 5b
  knowledge P8 (as_of) ◄── knowledge P7 point-in-time scenario
  memories P9 (profile) — sketch
  learned rules ⏭️ ◄── recurrence-view demand (open) + evals P1 ✔
```
