# SOAT Delivery Roadmap

The **single** roadmap for the platform: what is shipped, what is pending, and
what depends on what across every PRD in this directory. Each PRD owns its
design; this page owns status, sequencing, and the complete pending backlog.

> **This is the only roadmap.** Status and sequencing live here, not in the
> PRDs. A PRD's `Implementation Status` table is a local snapshot; when it
> disagrees with this page, this page wins. The [pending backlog](#pending-backlog)
> below is the authoritative list of every open item — it folds in the former
> `usage-roadmap.md` and `manage-by-exception-roadmap.md`, which have been
> removed.

## Legend

| Marker | Meaning |
|--------|---------|
| ✅ | Shipped |
| 🟡 | Partially shipped (core landed; phases remaining) |
| ❌ | Not started |
| ⏭️ | Deferred (blocked on an unbuilt dependency) |

## Initiatives at a glance

### Agent Operations on Formations (G1–G7)

The umbrella — [prd-agent-operations.md](./prd-agent-operations.md) — defines
the gap series that turns a Formation deploy into an *operating* agent team.

| G | Initiative | PRD | Status |
|---|-----------|-----|--------|
| G1 | Schedules / triggers | Triggers module | 🟡 triggers exist; schedule wiring per umbrella |
| G2 | Queue-backed runs | [prd-orchestration-queue.md](./prd-orchestration-queue.md) | 🟡 P1 (queue/idempotency/worker) + P2 (concurrency limits) shipped; worker-fleet ops hardening + P3 (SQS driver) remain |
| G3 | Approvals · exceptions · activity | [prd-approvals.md](./prd-approvals.md) | 🟡 Phase 1 + Phase 3 (exceptions queue) shipped; activity feed remains |
| G4 | Guardrails · action classes | [modules/guardrails.md](../packages/website/docs/modules/guardrails.md) | ✅ shipped |
| G5 | Usage metering | [prd-usage-metering.md](./prd-usage-metering.md) | 🟡 Phases 1–3c shipped; infra emitters + guard integ. remain |
| G6 | Learned-rules feedback loop | [prd-learned-rules.md](./prd-learned-rules.md) | ❌ Not started |
| G7 | Knowledge packages · context assembly | [prd-knowledge-packages.md](./prd-knowledge-packages.md) | ❌ Not started |

### Adjacent / standalone module PRDs

| Initiative | PRD | Status | Tie |
|-----------|-----|--------|-----|
| Agent versions & staged rollout | [prd-agent-versions.md](./prd-agent-versions.md) | ❌ Not started | umbrella (no G#) |
| Evaluations | [prd-evaluations.md](./prd-evaluations.md) | ❌ Not started | gates agent-versions |
| Audit log | [prd-audit-log.md](./prd-audit-log.md) | 🟡 Phase 1 shipped (table, write hook, read API, retention) | substrate for G3/G4 |
| Quotas | [prd-quotas.md](./prd-quotas.md) | ✅ Phases 1–3 shipped (monitor-breach audit entry deferred to audit-log) | umbrella (no G#) |
| Model routing | [prd-model-routing.md](./prd-model-routing.md) | ❌ Not started | complements G2 |
| Memories | [prd-memories.md](./prd-memories.md) | 🟡 Phases 1–4 shipped; 5 partial; 6–9 remain | data plane |
| Knowledge (retrieval surface) | [prd-knowledge.md](./prd-knowledge.md) | 🟡 Phases 1,2,4 shipped; 3,5,6,7 remain | data plane |
| Discussions / reasoning engine | [prd-discussions.md](./prd-discussions.md) | 🟡 Phases 0–2,4,5 shipped; 3 partial | standalone |

## Implementation dependency graph

Arrow = "needs before it can ship". Shipped nodes (✅) are the foundations
everything else builds on.

```
FOUNDATIONS (shipped)
  orchestration runtime ✅   orchestration-queue P1 ✅   orchestration-queue P2 ✅
  usage metering P1–3c ✅    guardrails core ✅           knowledge P1/2/4 ✅
  memories P1–4 ✅           approvals P1 ✅              discussions ✅          quotas P1 ✅
  audit-log P1 ✅            exceptions (G3 P3) ✅

next, deps satisfied ──────────────────────────────────────────────────────
  orchestration-queue P2 ops hardening (worker fleet) ◄── orchestration-queue P2 ✅
  orchestration-queue P3 (pluggable driver + SQS) ◄── orchestration-queue P1 ✅
  usage metering P4/P5/P6 (compute/storage/request emitters) ◄── P3b schema ✅

cross-initiative ──────────────────────────────────────────────────────────
  evaluations P2 (async) ◄── orchestration-queue P1 ✅
  audit-log P2 (guardrail ActivityEntry detail kind) ◄── audit-log P1 ✅
  memories P6 (entity graph) ◄──► knowledge P3 (entity queries)
  knowledge P5/P6/P7 (ranking, injection, evals)

feedback + governance loops ────────────────────────────────────────────────
  learned-rules ◄── approvals ✅ (capture rejections/edits)
               ◄── memories ✅ (reuse embedding similarity)
  knowledge-packages G7 ◄──► learned-rules G6 (packages inject rules;
                                               rules ride the assembler)
  agent-versions P3 (eval-gated promotion) ◄── evaluations P1
  approvals P4 (activity feed) ◄── audit-log (substrate) + guardrails (A/B labels)
```

### Edge reference

| Depends on | … to unblock | Why |
|-----------|--------------|-----|
| usage metering ✅ | guardrails `soat.usage.*` | budget guards read windowed usage sums |
| orchestration-queue P1 ✅ | evaluations P2 | async eval runs ride the RunTask queue |
| orchestration-queue P1 ✅ | usage metering exactly-once | run-scoped idempotency keys (metering already node-scopes its own) |
| guardrails ✅ | approvals routing | class-C routes into `ApprovalItem`; replaced per-binding `approval_policy` |
| guardrails P3 | audit-log P2 | `guardrail_evaluation` becomes one audit `detail` kind |
| guardrails A/B + audit-log | approvals P4 (activity feed) | feed labels autonomous class-A/B actions on the audit substrate |
| knowledge P3 ◄──► memories P6 | each other | knowledge owns entity *queries*; memories owns entity *data* + extraction |
| approvals ✅ + memories ✅ | learned-rules | captures rejection/edit signals; reuses pgvector similarity |
| knowledge-packages ◄──► learned-rules | each other | assembler injects active rules as one layer |
| evaluations P1 | agent-versions P3 | eval verdict is the promotion gate |
| — | model-routing | standalone; complements G2, no metering change |

## Recommended build order

1. **Usage infra emitters (P4–P6)** — pure extensions of shipped cores.
   (**Guardrails (G4)** is fully shipped. **Quotas** is
   done through P3: requests + token/cost enforcement, the `quota.exceeded`
   webhook, monitor mode, and the `quota` formation resource all shipped; only
   the monitor-breach *audit entry* remains, deferred to audit-log.
   **Orchestration-queue P1 and P2** shipped — P1 unblocked evaluations P2 and
   exactly-once metering; P2 added per-project + global concurrency limits, the
   queue-stats endpoint, and graceful worker shutdown. The worker-fleet **ops
   hardening** (compose service, healthcheck, fleet smoke) and the optional
   **P3 SQS driver** are the remaining queue steps.)
2. **Audit-log P2** (Phase 1 shipped) and **evaluations P1–P2** — the substrate
   the activity feed and agent-versions promotion gate need (audit-log also
   absorbs the deferred quota monitor-breach audit entry).
3. **Agent-versions**, **approvals P3/P4** (exceptions + activity feed).
4. **G6 learned-rules ↔ G7 knowledge-packages** — the feedback + doctrine loop,
   last because it consumes approvals, memories, and evaluations signals.
5. **Model-routing** and the deferred tail (budget-guard P7) as
   hardening.

## Pending backlog

Every open item across all PRDs. Grouped by initiative; task IDs (e.g. `4.1`)
are preserved from the former topic roadmaps. Blockers are noted inline.

### G2 — Orchestration queue

_Core durable runtime shipped (background execution, crash recovery, parking,
per-node retry, sync mode, lifecycle webhooks). **P1 shipped**: Postgres queue
driver (`run_tasks` claimed with `SELECT … FOR UPDATE SKIP LOCKED`), enqueue-only
async start (`status: "queued"`), extractable worker loop + `worker.ts`
entrypoint, and run-scoped node idempotency keys (`{run_id}:{node_id}:{attempt}`,
with the `Idempotency-Key` header on HTTP tool nodes). **P2 shipped**:
`max_concurrent_runs` per project (claim-time enforcement — excess runs stay
queued; only actively-driven runs hold a slot; advisory-locked so the cap holds
across a worker fleet), the `ORCHESTRATION_WORKER_CONCURRENCY` per-worker
cross-tick cap, graceful worker shutdown (SIGTERM/SIGINT), and
`GET /api/v1/orchestrations/queue/stats` (behind `orchestrations:GetQueueStats`)._

- [ ] **P2 ops hardening** — dedicated compose worker service, worker healthcheck, and worker-fleet smoke coverage (graceful shutdown already shipped)
- [ ] **P3** Pluggable driver + SQS: env-selected driver (`ORCHESTRATION_QUEUE_DRIVER=postgres|sqs`), SQS driver (visibility-timeout→lease, DLQ→`failed`), a shared driver-conformance suite, and a load/soak test

### G3 — Approvals (exceptions · activity)

_Phase 1 shipped (`ApprovalItem`, `approval` node, expiry, approve/reject/edit,
webhooks, REST). Phase 3 shipped: the
[exceptions](../packages/website/docs/modules/exceptions.md) queue
(`ExceptionItem`/`exc_`, auto-filed by exhausted retries, guardrail tripwires,
and expired approvals; `info`/`warning`/`critical` severity routing, occurrence
dedup, `open → acknowledged → resolved`, `exceptions.created` webhook).
"Approvals on every surface" shipped via the **G4 guardrail interceptor**; the
per-binding `approval_policy` was deprecated and removed._

- [ ] Dedup return-existing logic (the `dedup_key` column + partial unique index exist; the return-existing behavior does not)
- [ ] **Knowledge-version provenance** (was MbE M3 — unblocks the audit acceptance criterion):
  - [ ] `3.1` record `knowledge_version` on `generation.metadata` at emit time
  - [ ] `3.2` stamp `knowledgeVersion` / `policyVersion` onto `ApprovalItem` + the audit record via `emitApproval`
  - [ ] `3.3` join helper: run → generations → `knowledge_version` → approval
- [ ] **Phase 4 / activity feed** (was MbE M5 — needs G4 class-A/B labels + audit substrate):
  - [ ] `5.1` `ActivityEntry` feed (`acte_`) — one entry per autonomously executed action
  - [ ] `5.2` cursor-paginated `GET /api/v1/activity` (type / severity filters, per project)
  - [ ] `5.3` evidence + drill-through linkage (feed item → run → generations, agent/node/guardrail-version links)
  - [ ] `5.4` write `soat.activity.actions_24h` guard context (the `soat.*` key G4 guards assume nothing populates yet)
- [ ] **Phase 5** Approver targeting & assignment (route items to specific humans; deferred until demand)
- [ ] In-channel approval clients (WhatsApp/Slack) over the queue

### G4 — Guardrails

_Core shipped: standalone `guardrails` resource + `GuardrailVersion`,
classify→route interceptor, guard evaluation + application-owned context
(`args.*`/`context.*`/`soat.*`), project/agent/tool attach with stricter-wins
composition, tripwires + `escalate`, `guardrail_evaluation` audit record,
dry-run `evaluate` endpoint; per-binding `approval_policy` removed. **Client-tool
handoff gate shipped**: client calls are gated at the `requires_action` handoff
(A / passing B release; D blocks; a tripwire aborts the action and the model
continues; C files the approval and, on approval, re-hands the frozen/edited call
off to the client via a fresh linked `requires_action` generation) across the
agent-generation and session surfaces._

**Fully shipped — no open items.** The remaining backlog closed:

- Orchestration **tool-node** dispatch gate — `tool` nodes are gated at project + tool scope: A/B execute, D/tripwire produce a routable `blocked` node outcome, C parks the run and re-dispatches the tool with the frozen/edited args on approval (gate not re-evaluated).
- **Tripwire → exception** — a tripwire emits a `guardrail.tripwire` event that the [exceptions](../packages/website/docs/modules/exceptions.md) module files as a `guardrail_tripwire` exception (G3 Phase 3 shipped).
- **Per-guardrail approval expiry** — a guardrail document carries an optional `expires_in` (the governing guardrail's value sets the class-C approval window); no per-action-class taxonomy was introduced.

The authoritative contract is [modules/guardrails.md](../packages/website/docs/modules/guardrails.md).

### G5 — Usage metering

_Phases 1–3c shipped (event+component model, three-tier `PriceBook`, per-run
receipts, aggregation, thresholds + webhook)._

- [ ] 🚧 **Coverage:** meter the remaining LLM paths — extraction, discussions, chats (agents / conversations / orchestration nodes done)
- [ ] **P4** `4.1` Compute metering (`compute_execution` on node completion; duration from `started_at`/`completed_at`; `soat`/`compute-second` SKU)
- [ ] **P5** `4.2` Storage metering (daily per-project snapshot; `gb_day`; idempotency key `storage:{project}:{date}`)
- [ ] **P6** `4.3` API-request metering (flush-aggregated counting middleware; never one row per request)
- [ ] **P7** `5.2` `usage.*` guard context + per-run ceiling — ⏭️ deferred (needs the G4 evaluator; interim: a `condition` node reads the run roll-up and routes to an abort path)
- [ ] Backlog: event-driven storage byte accounting (replaces the daily-snapshot approximation)

### G6 — Learned rules

_Not started. Captures from G3 (rejections/edits); reuses memories embeddings;
injects through the G7 assembler._

- [ ] **Phase 1** Candidate capture: `CandidateRule` model + hooks (auto-created from rejections, edits, explicit corrections)
- [ ] **Phase 2** Recurrence detection: embedding nearest-neighbor clustering → `promotion_suggested`
- [ ] **Phase 3** Promotion lifecycle + `LearnedRule` (human-curated; `candidate → promoted | dismissed`)
- [ ] **Phase 4** Scoped context injection (`global` / `project`, most-specific last) via the G7 assembler
- [ ] REST endpoints + OpenAPI + permissions

### G7 — Knowledge packages

_Not started. Injects G6 rules; complements knowledge + memories._

- [ ] **Phase 1** Package storage, publish (tarball + manifest, publish-scoped key), pinning; `knowledge_package` formation resource type
- [ ] **Phase 2** Layered context assembler (pure function, per-layer token budgets; pulls active learned rules into a layer)
- [ ] **Phase 3** Confidentiality hardening (content encrypted at rest, never in list/get APIs, logs, or run events) + fenced non-system injection + test suite

### Agent versions

_Not started._

- [ ] **Phase 1** Version snapshots + list/get/restore: `AgentVersion` model + snapshot-on-write hook; `version` column on Agent; restore is append-only
- [ ] **Phase 2** Releases + deterministic canary: `active_release` (stable/canary split, per-actor deterministic assignment); served-version stamping (`agent_version` in generation metadata); promote / abort endpoints
- [ ] **Phase 3** Eval-gated promotion (`promotion_gate`) — needs **Evaluations Phase 1+**

### Evaluations

_Not started._

- [ ] **Phase 1** Datasets + evals + sync deterministic runs: `Dataset`/`DatasetItem`, `Eval` config, `EvalRun`/`EvalResult`; deterministic scorers (`exact_match`, `contains`, `json_logic`, `output_schema`); sync capped-item execution (`wait: true`)
- [ ] **Phase 2** `llm_judge` scorer; async execution on the RunTask queue (**needs Orchestration-queue P1**); baseline comparison + pass/fail gating; curate dataset items from traces/generations
- [ ] **Phase 3** Scheduled evals (cron triggers) + `eval` formation resource type
- [ ] Webhook events (`eval_run.completed` / `.failed`)

### Audit log

_Phase 1 shipped (this is the former MbE M4): `AuditEntry` (`audit_`,
append-only, no UPDATE/DELETE at the model layer), the `X-Request-Id`
middleware, the post-commit write hook wrapping `isAllowed` (fire-and-forget,
bounded queue), the read API (`GET /api/v1/audit-log` + `/{entry_id}`), the
`audit:ListAuditEntries` / `GetAuditEntry` actions, and the `AUDIT_RETENTION_DAYS`
retention sweep. Reconcile activity-feed ownership with G3 before shipping the
feed._

- [ ] **Phase 2** Guardrails `ActivityEntry` as one `detail` kind (**needs G4 Phase 3**)
- [ ] **Phase 3** Read-audit config flag (off by default) + `audit.entry_created` webhook
- [ ] Per-project NDJSON export (paginate the list endpoint; also serves LGPD)

### Quotas

_Hard fail-closed enforcement (429), complementing metering (measure) and
guardrails (per-action). **Phases 1–3 shipped**: requests quotas (`Quota` +
`QuotaWindowCounter` models, CRUD, the request-quota Koa middleware with an
atomic `UPDATE … RETURNING`, and the `QUOTA_EXCEEDED` + `429` + `Retry-After`
contract); token/cost quotas enforced at the pre-generation check over
`UsageEvent` (`project`/`agent` scopes; never kills an in-flight generation;
`api_key` token/cost rejected — no attribution); and the `quota.exceeded`
webhook (once per fixed window, enforce + monitor), monitor mode (fire without
blocking), and the `quota` formation resource._

- [ ] Monitor-breach **audit entry** — deferred to the audit-log module. The
  `AuditEntry` model now exists (audit-log Phase 1 shipped), so this is
  unblocked wiring rather than a blocked dependency; the `quota.exceeded`
  webhook remains the interim durable signal.

### Model routing

_Not started. Standalone; complements G2; no metering change (metering prices
off the served provider/model)._

- [ ] **Phase 1** `ModelRoute` model + lib (`route_` prefix, ordered targets + retry/breaker config); REST CRUD + OpenAPI + permissions; shared `route`-vs-pin exclusivity validation; agent consumption (`model_route_id`); ordered fallback executor (non-streaming)
- [ ] **Phase 2** Circuit breaker (in-process, per-target consecutive-failure skip + cooldown); streaming pre-token fallback; `routing` metadata on Generation
- [ ] **Phase 3** Remaining consumers (discussions, extraction, chats); `model-route` formation resource type

### Memories

_Phases 1–4 shipped (storage + write v1, agent read/write, tags, automatic
extraction)._

- [ ] 🟡 **Phase 5** Write algorithm v2 (LLM-arbitrated, temporal) — LLM merge-consolidation shipped; manual REST writes still concatenate:
  - [ ] `5a` top-K shortlist + LLM decision (add / update / supersede / skip)
  - [ ] `5b` temporal invalidation (`invalidatedAt` + `supersededByEntryId`; contradictions retire old facts)
  - [ ] `5c` entry provenance (`sourceGenerationId` / `sourceConversationId`)
- [ ] **Phase 6** Entity graph layer: `MemoryEntity` (`mey_`) + `MemoryEntityEdge`; async entity extraction on write; `resolveEntitySearch()` (query surface ↔ **Knowledge Phase 3**)
- [ ] **Phase 7** Extraction coverage for streaming and `requires_action` completions
- [ ] **Phase 8** Forgetting: importance scoring, access tracking, retrieval-time recency blend, compaction
- [ ] **Phase 9** Profile memory (always-injected bounded blocks, agent-editable)

### Knowledge (retrieval surface)

_Phases 1, 2, 4 shipped (unified `/knowledge/search`, document + memory
sources, post-conversation extraction)._

- [ ] **Phase 3** Entity graph queries (`entity_ids` / `entity_names` / `actor_ids` filters; graph traversal via `predicate`/`direction`) — **needs Memories Phase 6**
- [ ] **Phase 5** Hybrid retrieval & ranking: lexical + vector (`tsvector`/BM25 + pgvector); RRF result merging (replaces the raw-score interleave — a known weakness); optional reranking; recency/importance weighting (importance from Memories Phase 8)
- [ ] **Phase 6** Injection hardening: retrieved knowledge injected as delimited **non-system** content (currently `role: system` — a prompt-injection escalation path)
- [ ] **Phase 7** Evaluation harness & observability: golden query set, recall@k / MRR, memory benchmarks, injected-context tracing

### Discussions / reasoning engine

_Phases 0–2, 4, 5 shipped (reasoning pipeline, reflect/debate normalized onto
it, Discussions resource MVP, reasoning removed from agents)._

- [ ] 🟡 **Phase 3** remainder: async pipeline generate (`?async=true` + poll) — depends on the session async mechanism; optional `reasoning.budget` guard (cap total completions per run; today a fixed `MAX_TOTAL_COMPLETIONS=24` engine cap applies)
- [ ] Deferred Discussion-resource seams: async run, human-in-the-loop participants, `organizer_selects` turn policy, real-Agent participants, orchestration `discussion` node type, webhooks, cancellation/pause states

## Cross-cutting reconciliations

Open consistency items the PRDs still carry — flagged here so the roadmap
stays the source of truth:

- **Activity-feed ownership.** Both [prd-audit-log.md](./prd-audit-log.md)
  (`AuditEntry.detail`) and [prd-approvals.md](./prd-approvals.md)
  (`ActivityEntry`, `acte_`) describe an activity substrate. Audit-log claims
  to "provide the activity substrate approvals assumes" — settle which model
  owns the feed before either ships (drives approvals Phase 4).
- **`tool_ids` → `tool_bindings`.** The 2026-07 promotion to a canonical
  `tool_bindings` array (approvals §5) postdates the `tool_ids: [{ ref: … }]`
  shape still shown in [prd-agent-operations.md](./prd-agent-operations.md)'s
  End State YAML — update the example.
- **`PolicyVersion` reference.** [prd-learned-rules.md](./prd-learned-rules.md)
  cites the guardrails `PolicyVersion` pattern for `LearnedRuleVersion`;
  guardrails renamed it `GuardrailVersion`. Cosmetic, but update on next touch.
