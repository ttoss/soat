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
Only initiatives with open work are listed. G1 (schedule triggers), G2
(queue-backed runs), G4 (guardrails), and G5 (usage metering) are fully shipped
and have no remaining items. The G2 and G5 PRDs have been retired in favor of
the [orchestrations module doc](../packages/website/docs/modules/orchestrations.md#durable-background-execution)
and the [usage module doc](../packages/website/docs/modules/usage.md); G5's one
open refinement is kept in the [backlog](#g5--usage-metering) below.

| G | Initiative | PRD | Remaining |
|---|-----------|-----|-----------|
| G3 | Approvals · exceptions · activity | [prd-approvals.md](./prd-approvals.md) | ✅ shipped (Phase 5 approver targeting and in-channel approval clients remain deferred, no demand signal yet) |
| G6 | Learned-rules feedback loop | [prd-learned-rules.md](./prd-learned-rules.md) | ⏭️ Deferred — recurrence view folded into G3 (see [Deferral: learned rules](#deferral-learned-rules)) |

### Adjacent / standalone module PRDs

Only PRDs with open work are listed. Three initiatives are fully shipped and
their PRDs have been retired — the live behavior lives in the module docs:
[quotas](../packages/website/docs/modules/quotas.md) (request/token/cost
quotas, the `QUOTA_EXCEEDED` / `429` contract, monitor mode with its
[breach audit entry](../packages/website/docs/modules/quotas.md#monitor-mode),
the `quota.exceeded` webhook, and the `quota` formation resource),
[audit-log](../packages/website/docs/modules/audit-log.md) (the read-auditing
flag, the `audit.entry_created` webhook, and the per-project NDJSON export), and
[usage](../packages/website/docs/modules/usage.md) (the event + component model,
price book, receipts, aggregation, thresholds, every LLM path metered, the
compute/storage/request dimensions, and the `soat.usage.*` spend guards).

| Initiative | PRD | Remaining | Tie |
|-----------|-----|-----------|-----|
| Agent versions & staged rollout | [prd-agent-versions.md](./prd-agent-versions.md) | ❌ Not started | umbrella (no G#) |
| Evaluations | [prd-evaluations.md](./prd-evaluations.md) | ❌ Not started | gates agent-versions |
| Model routing | [prd-model-routing.md](./prd-model-routing.md) | ❌ Not started | complements G2 |
| Memories | [prd-memories.md](./prd-memories.md) | 🟡 Phase 5 partial; 6–9 remain | data plane |
| Knowledge (retrieval surface) | [prd-knowledge.md](./prd-knowledge.md) | 🟡 Phases 3,5,6,7 remain | data plane |
| Discussions / reasoning engine | [prd-discussions.md](./prd-discussions.md) | 🟡 Phase 3 remainder + deferred seams | standalone |

## Implementation dependency graph

Arrow = "needs before it can ship". Only pending nodes are shown; the shipped
foundations they build on (orchestration runtime, the queue-backed durable
runtime, usage metering, guardrails, knowledge P1/2/4, memories P1–4, approvals
P1/P3, discussions core, quotas, audit-log P1) are omitted. A `✔` marks a dependency that is already
satisfied by shipped work.

```
cross-initiative ──────────────────────────────────────────────────────────
  evaluations P2 (async) ◄── queue-backed durable runtime ✔
  memories P6 (entity graph) ◄──► knowledge P3 (entity queries)
  knowledge P5/P6/P7 (ranking, injection, evals)

feedback + governance loops ────────────────────────────────────────────────
  approvals recurrence view (G3) ✔ ◄── approvals ✔ (dedup_key + previous_item_id chains)
  learned-rules ⏭️ deferred ◄── recurrence-view demand + evaluations P1 (efficacy gate)
  agent-versions P3 (eval-gated promotion) ◄── evaluations P1
  approvals P4 (activity feed) ✔ ◄── audit-log (substrate) + guardrails (A/B labels)
```

### Edge reference

| Depends on | … to unblock | Why |
|-----------|--------------|-----|
| queue-backed durable runtime ✔ | evaluations P2 | async eval runs ride the RunTask queue |
| knowledge P3 ◄──► memories P6 | each other | knowledge owns entity *queries*; memories owns entity *data* + extraction |
| approvals ✔ | approvals recurrence view (G3) ✔ | rolls up `dedup_key` chains + rejection reasons already persisted on `ApprovalItem` |
| recurrence-view demand + evaluations P1 | learned-rules ⏭️ | semantic clustering + soft rules build only if the exact-key view proves demand and evals can measure rule efficacy |
| evaluations P1 | agent-versions P3 | eval verdict is the promotion gate |
| audit-log + guardrails ✔ | approvals P4 (activity feed) ✔ | feed labels autonomous class-A/B actions on the audit substrate |
| — | model-routing | standalone; complements G2 ✔, no metering change |

## Recommended build order

1. ~~**Usage metering (G5)**~~ — **fully shipped**: every LLM path metered, the
   compute/storage/request dimensions, and the `soat.usage.*` spend guards
   (project windows and per-run ceilings).
2. ~~**Audit log**~~ — **fully shipped** (P2 selective-write of
   decision-changing guardrail evaluations, P3 read-auditing flag +
   `audit.entry_created` webhook, and the per-project NDJSON export).
   **Evaluations P1–P2** remain — the substrate the activity feed and
   agent-versions promotion gate need.
3. **Agent-versions**.
4. ~~**Approvals recurrence view (G3)**~~ — **shipped**: the read-only feedback
   surface whose usage is the demand gate for the deferred learned-rules module.
   ~~**Approvals P3/P4 (exceptions + activity feed)**~~ — **shipped**.
5. **Model-routing** as hardening.

## Pending backlog

Every open item across all PRDs. Grouped by initiative; task IDs (e.g. `4.1`)
are preserved from the former topic roadmaps. Blockers are noted inline.

### G3 — Approvals (exceptions · activity)

- [x] Dedup return-existing logic (`emitApproval` fast path + create-time unique-violation backstop over the partial unique index) + `previous_item_id` threading on re-proposals matching a rejected item (approvals decision 2)
- [x] **Recurrence view** — `GET /api/v1/approvals/recurrences`: read-only rollup of `previous_item_id` chains grouped by `dedup_key` (count, ordered chain, rejection reasons); the guardrail-graduation prompt and the demand gate for deferred G6. Live behavior in [approvals module docs](../packages/website/docs/modules/approvals.md#recurrence-view)
- [x] **Phase 4 / activity feed** — shipped (2026-07). Live behavior in the [activity module docs](../packages/website/docs/modules/activity.md):
  - [x] `5.1` `ActivityEntry` feed (`acte_`) — one entry per autonomously executed action
  - [x] `5.2` cursor-paginated `GET /api/v1/activity` (kind / severity filters, per project)
  - [x] `5.3` evidence + drill-through linkage (`run_id`/`agent_id` columns; node id, generation id, guardrail policy version in `detail`) — `action_executed` coverage has a known v1 gap: only the orchestration tool-node executor is instrumented, not agent-generation-time tool calls (see [activity module docs](../packages/website/docs/modules/activity.md#producers))
  - [ ] `5.4` write `soat.activity.actions_24h` guard context — not started
- [ ] **Phase 5** Approver targeting & assignment (route items to specific humans; deferred until demand)
- [ ] In-channel approval clients (WhatsApp/Slack) over the queue

### G5 — Usage metering

✅ **Shipped.** The initiative is complete and its PRD retired; live behavior is
documented in the [usage module doc](../packages/website/docs/modules/usage.md).
One refinement remains open:

- [ ] **Event-driven storage byte accounting** — replace the daily storage
      snapshot with incremental byte deltas on file/document mutation,
      eliminating the intra-day sampling drift the snapshot accepts

### G6 — Learned rules — ⏭️ Deferred

_Deferred (2026-07) — see [Deferral: learned rules](#deferral-learned-rules).
Exact-key recurrence surfacing moved to G3 (approvals recurrence view). What
remains here builds only if the recurrence view proves demand **and**
evaluations P1 exists to measure rule efficacy — both gates in
[prd-learned-rules.md](./prd-learned-rules.md)._

- [ ] ⏭️ Semantic (embedding) clustering of paraphrased corrections (`CandidateRule` capture + nearest-neighbor recurrence)
- [ ] ⏭️ Promotion lifecycle + `LearnedRule` (human-curated; `candidate → promoted | dismissed`)
- [ ] ⏭️ Scoped rule listing API (`global` / `project`) so the consuming app can fetch active rules to inject

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

_Fully shipped._

- [x] **Phase 2** Decision-changing guardrail evaluations (`route_to_approval` / `blocked` / `tripwire`) mirror into `AuditEntry` as `detail.kind = "guardrail_evaluation"` via selective-write from `persistGuardrailEvaluations`; plain `execute` stays in the dedicated `guardrail_evaluations` table. Platform-originated (`action: guardrails:Evaluate`, null principal). Live behavior in the [audit-log module docs](../packages/website/docs/modules/audit-log.md#system-originated-entries)
- [x] **Phase 3** Read-audit config flag — `audit_reads_enabled` on the project, off by default, gated at enqueue via a 30s per-project cache so read traffic never evicts mutation entries from the audit queue; a read naming no project is never audited. Plus the `audit.entry_created` webhook, emitted from the `writeAuditEntry` choke point with the full snake_case entry as its `data` (project-scoped entries only). Live behavior in the [audit-log module docs](../packages/website/docs/modules/audit-log.md#read-auditing)
- [x] **Per-project NDJSON export** — `GET /api/v1/audit-log/export`: streams one snake_case entry per line, oldest first, paged internally; `project_id` required and authorized by its own `audit:ExportAuditEntries` action (bulk egress is granted separately from read). Also serves LGPD/GDPR subject-access requests. Live behavior in the [audit-log module docs](../packages/website/docs/modules/audit-log.md#ndjson-export)

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

- **Activity-feed ownership — resolved (2026-07), shipped.** The shipped
  [`AuditEntry`](../packages/website/docs/modules/audit-log.md) (`detail` kinds)
  and [prd-approvals.md](./prd-approvals.md) (`ActivityEntry`, `acte_`) both
  described an activity substrate; settled as two distinct models with a firm
  boundary rather than one. Audit-shaped events stay on `AuditEntry` — that part
  was already narrowed: a policy `deny` is recorded as an ordinary entry with
  `status = 403` (there is no `detail.kind = 'action_denied'` marker, despite an
  earlier revision of this line claiming one), and a decision-changing guardrail
  evaluation is mirrored there as `detail->>'kind' = 'guardrail_evaluation'`. The remaining product-feed question (which model owns
  agent/run-centric autonomous-execution telemetry) is resolved: the PRD's own
  `ActivityEntry`, per [prd-approvals.md decision 4](./prd-approvals.md#decisions-formerly-open-questions) —
  `AuditEntry`'s `action` column is documented as the permission-action string
  that authorized a request, and none of `ActivityEntry`'s four kinds
  (`action_executed`, `approval_resolved`, `exception_created`,
  `schedule_fired`) is an authorization event, so folding them in would have
  bolted agent/run provenance onto a compliance-grade audit table customers
  pipe to SIEMs. Live behavior in the
  [activity module docs](../packages/website/docs/modules/activity.md).
- **`tool_ids` → `tool_bindings`.** The 2026-07 promotion to a canonical
  `tool_bindings` array (approvals §5) postdates the `tool_ids: [{ ref: … }]`
  shape still shown in [prd-agent-operations.md](./prd-agent-operations.md)'s
  End State YAML — update the example.
- **`PolicyVersion` reference.** ~~Stale `PolicyVersion` citations in
  [prd-learned-rules.md](./prd-learned-rules.md) and
  [prd-agent-versions.md](./prd-agent-versions.md)~~ — fixed (both now cite
  `GuardrailVersion`).

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
  through a scoped listing API and the app injects them. (Since narrowed
  further — see [Deferral: learned rules](#deferral-learned-rules).)
- If a future need appears for SOAT to *hold and protect confidential doctrine*
  (the one requirement the app cannot satisfy on its own), revisit as a new,
  narrowly-scoped initiative — do not resurrect the full package concept on
  spec.

### Deferral: learned rules

**Decision (2026-07): the learned-rules module is deferred; recurrence
surfacing folds into approvals as a read-only view.**

The module's platform-unique asset is the recurrence signal over human
corrections — and its raw material already persists on `ApprovalItem`
(`resolution_reason`, `edited_arguments`, `dedup_key`, `previous_item_id`).
Consequences:

- **Exact-key recurrence ships as the approvals
  [recurrence view](./prd-approvals.md#recurrence-view--not-started) (G3)** —
  zero new models, zero AI-provider coupling in a deliberately deterministic
  module, and its output is a guardrail graduation prompt ("rejected 4×,
  encode a `deny`"): a hard, enforceable, platform-owned outcome.
- **Candidate capture is backfillable.** Rejection/edit candidates can be
  rebuilt from approval history at any time, so deferring loses no data (only
  explicit manual corrections are non-retrofittable).
- **Soft-rule promotion/injection is eval-gated.** Rules are soft context; the
  efficacy question ("does injection change behavior?") is unanswerable until
  evaluations P1 exists.

Build gates for the full module — **both** must hold: sustained demand on the
recurrence view (humans graduating groups into guardrails *and* hitting the
exact-match ceiling on paraphrased corrections), and evaluations P1 shipped.
Details in [prd-learned-rules.md](./prd-learned-rules.md).
