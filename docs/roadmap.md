# SOAT Delivery Roadmap — Pending Backlog

The **single** roadmap for the platform's *remaining* work: what is still
pending and what depends on what across every PRD in this directory. Shipped
functionality has been removed from this page and from the PRDs — the live
behavior is documented in the website module docs
(`packages/website/docs/modules/`). This page owns sequencing and the complete
pending backlog.

> **This is the only roadmap.** Sequencing lives here, not in the PRDs. The
> [pending backlog](#pending-backlog) below is the authoritative list of every
> open item.

## Legend

| Marker | Meaning |
|--------|---------|
| ❌ | Not started |
| 🟡 | Partially shipped (core landed; phases remaining) |
| ⏭️ | Deferred (blocked on an unbuilt dependency) |

## Initiatives at a glance

### Agent Operations on Formations (G1–G6)

The umbrella — [prd-agent-operations.md](./prd-agent-operations.md) — defines
the gap series that turns a Formation deploy into an *operating* agent team.
Only initiatives with open work are listed (G1 schedule triggers and G4
guardrails are fully shipped and have no remaining items).

| G | Initiative | PRD | Remaining |
|---|-----------|-----|-----------|
| G2 | Queue-backed runs | [prd-orchestration-queue.md](./prd-orchestration-queue.md) | 🟡 worker-fleet ops hardening + P3 (SQS driver) |
| G3 | Approvals · exceptions · activity | [prd-approvals.md](./prd-approvals.md) | 🟡 activity feed remains (dedup shipped) |
| G5 | Usage metering | [prd-usage-metering.md](./prd-usage-metering.md) | 🟡 storage/request emitters + coverage + guard integ. |
| G6 | Learned-rules feedback loop | [prd-learned-rules.md](./prd-learned-rules.md) | ❌ Not started |

### Adjacent / standalone module PRDs

Only PRDs with open work are listed (quotas is fully shipped save one deferred
audit entry — see [prd-quotas.md](./prd-quotas.md)).

| Initiative | PRD | Remaining | Tie |
|-----------|-----|-----------|-----|
| Agent versions & staged rollout | [prd-agent-versions.md](./prd-agent-versions.md) | ❌ Not started | umbrella (no G#) |
| Evaluations | [prd-evaluations.md](./prd-evaluations.md) | ❌ Not started | gates agent-versions |
| Audit log | [prd-audit-log.md](./prd-audit-log.md) | 🟡 P2/P3 + export remain | substrate for G3/G4 |
| Model routing | [prd-model-routing.md](./prd-model-routing.md) | ❌ Not started | complements G2 |
| Memories | [prd-memories.md](./prd-memories.md) | 🟡 Phase 5 partial; 6–9 remain | data plane |
| Knowledge (retrieval surface) | [prd-knowledge.md](./prd-knowledge.md) | 🟡 Phases 3,5,6,7 remain | data plane |
| Discussions / reasoning engine | [prd-discussions.md](./prd-discussions.md) | 🟡 Phase 3 remainder + deferred seams | standalone |

## Implementation dependency graph

Arrow = "needs before it can ship". Only pending nodes are shown; the shipped
foundations they build on (orchestration runtime, queue P1/P2, metering
P1–P4, guardrails, knowledge P1/2/4, memories P1–4, approvals P1/P3,
discussions core, quotas, audit-log P1) are omitted. A `✔` marks a dependency
that is already satisfied by shipped work.

```
queue ────────────────────────────────────────────────────────────────────────
  orchestration-queue P2 ops hardening (worker fleet)
  orchestration-queue P3 (pluggable driver + SQS)

usage ────────────────────────────────────────────────────────────────────────
  usage metering P5/P6 (storage/request emitters)

cross-initiative ──────────────────────────────────────────────────────────
  evaluations P2 (async) ◄── orchestration-queue P1 ✔
  audit-log P2 (guardrail ActivityEntry detail kind) ◄── guardrails Phase 3 ✔
  memories P6 (entity graph) ◄──► knowledge P3 (entity queries)
  knowledge P5/P6/P7 (ranking, injection, evals)

feedback + governance loops ────────────────────────────────────────────────
  learned-rules ◄── approvals ✔ (capture rejections/edits)
               ◄── memories ✔ (reuse embedding similarity)
               (active rules exposed via API; the consuming app injects them)
  agent-versions P3 (eval-gated promotion) ◄── evaluations P1
  approvals P4 (activity feed) ◄── audit-log (substrate) + guardrails (A/B labels)
```

### Edge reference

| Depends on | … to unblock | Why |
|-----------|--------------|-----|
| orchestration-queue P1 ✔ | evaluations P2 | async eval runs ride the RunTask queue |
| guardrails P3 ✔ | audit-log P2 | `guardrail_evaluation` becomes one audit `detail` kind |
| knowledge P3 ◄──► memories P6 | each other | knowledge owns entity *queries*; memories owns entity *data* + extraction |
| approvals ✔ + memories ✔ | learned-rules | captures rejection/edit signals; reuses pgvector similarity |
| evaluations P1 | agent-versions P3 | eval verdict is the promotion gate |
| audit-log + guardrails ✔ | approvals P4 (activity feed) | feed labels autonomous class-A/B actions on the audit substrate |
| — | model-routing | standalone; complements G2, no metering change |

## Recommended build order

1. **Usage infra emitters (P5–P6)** — pure extensions of shipped cores.
2. **Audit-log P2** and **evaluations P1–P2** — the substrate the activity feed
   and agent-versions promotion gate need (audit-log also absorbs the deferred
   quota monitor-breach audit entry).
3. **Agent-versions**, **approvals P3/P4** (exceptions + activity feed).
4. **G6 learned-rules** — the feedback loop, last because it consumes
   approvals, memories, and evaluations signals; active rules are exposed via
   API for the consuming application to inject into agent context.
5. **Model-routing** and the deferred tail (budget-guard P7) as hardening.

## Pending backlog

Every open item across all PRDs. Grouped by initiative; task IDs (e.g. `4.1`)
are preserved from the former topic roadmaps. Blockers are noted inline.

### G2 — Orchestration queue

- [ ] **P2 ops hardening** — dedicated compose worker service, worker healthcheck, and worker-fleet smoke coverage
- [ ] **P3** Pluggable driver + SQS: env-selected driver (`ORCHESTRATION_QUEUE_DRIVER=postgres|sqs`), SQS driver (visibility-timeout→lease, DLQ→`failed`), a shared driver-conformance suite, and a load/soak test

### G3 — Approvals (exceptions · activity)

- [x] Dedup return-existing logic (`emitApproval` fast path + create-time unique-violation backstop over the partial unique index) + `previous_item_id` threading on re-proposals matching a rejected item (approvals decision 2)
- [ ] **Phase 4 / activity feed** (needs G4 class-A/B labels + audit substrate):
  - [ ] `5.1` `ActivityEntry` feed (`acte_`) — one entry per autonomously executed action
  - [ ] `5.2` cursor-paginated `GET /api/v1/activity` (type / severity filters, per project)
  - [ ] `5.3` evidence + drill-through linkage (feed item → run → generations, agent/node/guardrail-version links)
  - [ ] `5.4` write `soat.activity.actions_24h` guard context
- [ ] **Phase 5** Approver targeting & assignment (route items to specific humans; deferred until demand)
- [ ] In-channel approval clients (WhatsApp/Slack) over the queue

### G5 — Usage metering

- [ ] 🚧 **Coverage:** meter the remaining LLM paths — extraction, discussions, chats (agents / conversations / orchestration nodes done)
- [ ] **P5** `4.2` Storage metering (daily per-project snapshot; `gb_day`; idempotency key `storage:{project}:{date}`)
- [ ] **P6** `4.3` API-request metering (flush-aggregated counting middleware; never one row per request)
- [ ] **P7** `5.2` `usage.*` guard context + per-run ceiling — ⏭️ deferred (needs the G4 evaluator; interim: a `condition` node reads the run roll-up and routes to an abort path)
- [ ] Backlog: event-driven storage byte accounting (replaces the daily-snapshot approximation)

### G6 — Learned rules

_Not started. Captures from G3 (rejections/edits); reuses memories embeddings.
Context assembly (deciding what doctrine/rules to inject and in what order) is
the consuming application's responsibility, not SOAT's — see [Boundary:
context composition](#boundary-context-composition); SOAT exposes active rules
through the API for the app to inject._

- [ ] **Phase 1** Candidate capture: `CandidateRule` model + hooks (auto-created from rejections, edits, explicit corrections)
- [ ] **Phase 2** Recurrence detection: embedding nearest-neighbor clustering → `promotion_suggested`
- [ ] **Phase 3** Promotion lifecycle + `LearnedRule` (human-curated; `candidate → promoted | dismissed`)
- [ ] **Phase 4** Scoped rule listing API (`global` / `project`) so the consuming app can fetch active rules to inject
- [ ] REST endpoints + OpenAPI + permissions

### Agent versions

_Not started._

- [ ] **Phase 1** Version snapshots + list/get/restore: `AgentVersion` model + snapshot-on-write hook; `version` column on Agent; restore is append-only
- [ ] **Phase 2** Releases + deterministic canary: `active_release` (stable/canary split, per-actor deterministic assignment); served-version stamping (`agent_version` in generation metadata); promote / abort endpoints
- [ ] **Phase 3** Eval-gated promotion (`promotion_gate`) — needs **Evaluations Phase 1+**

### Evaluations

_Not started._

- [ ] **Phase 1** Datasets + evals + sync deterministic runs: `Dataset`/`DatasetItem`, `Eval` config, `EvalRun`/`EvalResult`; deterministic scorers (`exact_match`, `contains`, `json_logic`, `output_schema`); sync capped-item execution (`wait: true`)
- [ ] **Phase 2** `llm_judge` scorer; async execution on the RunTask queue (**needs Orchestration-queue P1** ✔); baseline comparison + pass/fail gating; curate dataset items from traces/generations
- [ ] **Phase 3** Scheduled evals (cron triggers) + `eval` formation resource type
- [ ] Webhook events (`eval_run.completed` / `.failed`)

### Audit log

- [ ] **Phase 2** Guardrails `ActivityEntry` as one `detail` kind (guardrails Phase 3 ✔)
- [ ] **Phase 3** Read-audit config flag (off by default) + `audit.entry_created` webhook
- [ ] Per-project NDJSON export (paginate the list endpoint; also serves LGPD)

### Quotas

- [ ] Monitor-breach **audit entry** — deferred to the audit-log module. The
  `AuditEntry` model exists (audit-log Phase 1 shipped), so this is unblocked
  wiring; the `quota.exceeded` webhook remains the interim durable signal.

### Model routing

_Not started. Standalone; complements G2; no metering change._

- [ ] **Phase 1** `ModelRoute` model + lib (`route_` prefix, ordered targets + retry/breaker config); REST CRUD + OpenAPI + permissions; shared `route`-vs-pin exclusivity validation; agent consumption (`model_route_id`); ordered fallback executor (non-streaming)
- [ ] **Phase 2** Circuit breaker (in-process, per-target consecutive-failure skip + cooldown); streaming pre-token fallback; `routing` metadata on Generation
- [ ] **Phase 3** Remaining consumers (discussions, extraction, chats); `model-route` formation resource type

### Memories

- [ ] 🟡 **Phase 5** Write algorithm v2 (LLM-arbitrated, temporal) — LLM merge-consolidation shipped; manual REST writes still concatenate:
  - [ ] `5a` top-K shortlist + LLM decision (add / update / supersede / skip)
  - [ ] `5b` temporal invalidation (`invalidatedAt` + `supersededByEntryId`; contradictions retire old facts)
  - [ ] `5c` entry provenance (`sourceGenerationId` / `sourceConversationId`)
- [ ] **Phase 6** Entity graph layer: `MemoryEntity` (`mey_`) + `MemoryEntityEdge`; async entity extraction on write; `resolveEntitySearch()` (query surface ↔ **Knowledge Phase 3**)
- [ ] **Phase 7** Extraction coverage for streaming and `requires_action` completions
- [ ] **Phase 8** Forgetting: importance scoring, access tracking, retrieval-time recency blend, compaction
- [ ] **Phase 9** Profile memory (always-injected bounded blocks, agent-editable)

### Knowledge (retrieval surface)

- [ ] **Phase 3** Entity graph queries (`entity_ids` / `entity_names` / `actor_ids` filters; graph traversal via `predicate`/`direction`) — **needs Memories Phase 6**
- [ ] **Phase 5** Hybrid retrieval & ranking: lexical + vector (`tsvector`/BM25 + pgvector); RRF result merging (replaces the raw-score interleave — a known weakness); optional reranking; recency/importance weighting (importance from Memories Phase 8)
- [ ] **Phase 6** Injection hardening: retrieved knowledge injected as delimited **non-system** content (currently `role: system` — a prompt-injection escalation path)
- [ ] **Phase 7** Evaluation harness & observability: golden query set, recall@k / MRR, memory benchmarks, injected-context tracing

### Discussions / reasoning engine

- [ ] 🟡 **Phase 3** remainder: async pipeline generate (`?async=true` + poll) — depends on the session async mechanism; optional `reasoning.budget` guard (cap total completions per run; today a fixed `MAX_TOTAL_COMPLETIONS=24` engine cap applies)
- [ ] Deferred Discussion-resource seams: async run, human-in-the-loop participants, `organizer_selects` turn policy, real-Agent participants, orchestration `discussion` node type, webhooks, cancellation/pause states

## Cross-cutting reconciliations

Open consistency items the PRDs still carry — flagged here so the roadmap
stays the source of truth:

- **Activity-feed ownership.** Both [prd-audit-log.md](./prd-audit-log.md)
  (`AuditEntry.detail`) and [prd-approvals.md](./prd-approvals.md)
  (`ActivityEntry`, `acte_`) describe an activity substrate. Settle which model
  owns the feed before either ships (drives approvals Phase 4). Partially
  narrowed: approvals decision 3 lands guardrail-`deny` records as
  `AuditEntry` `detail->>'kind' = 'action_denied'`, so new audit-shaped kinds
  go to `AuditEntry`; only the product-feed model question remains open.
- **`tool_ids` → `tool_bindings`.** The 2026-07 promotion to a canonical
  `tool_bindings` array (approvals §5) postdates the `tool_ids: [{ ref: … }]`
  shape still shown in [prd-agent-operations.md](./prd-agent-operations.md)'s
  End State YAML — update the example.
- **`PolicyVersion` reference.** ~~[prd-learned-rules.md](./prd-learned-rules.md)
  cites the guardrails `PolicyVersion` pattern for `LearnedRuleVersion`~~ —
  fixed (now cites `GuardrailVersion`). The same stale name still appears in
  [prd-agent-versions.md](./prd-agent-versions.md); update on next touch.

### Boundary: context composition

**Decision (2026-07): knowledge packages are removed; prompt/context
composition is the consuming application's responsibility, not SOAT's.**

SOAT owns identity, memory, retrieval, execution, orchestration, governance,
and provenance. Deciding *what doctrine/rules to inject into an agent's context
and in what order* is application logic — the app owns its doctrine source, its
versioning, and its CI, and it injects assembled context at call time through
the existing seams (the agent `instructions` field and per-generation input
messages). The former G7 "knowledge packages · layered context assembler"
initiative (versioned immutable packages, encrypted-at-rest content, a
budgeted layered assembler) is therefore dropped rather than deferred.

Consequences captured elsewhere on this page:

- G6 learned rules no longer "ride an assembler": SOAT exposes active rules
  through a scoped listing API and the app injects them.
- If a future need appears for SOAT to *hold and protect confidential doctrine*
  (the one requirement the app cannot satisfy on its own), revisit as a new,
  narrowly-scoped initiative — do not resurrect the full package concept on
  spec.
