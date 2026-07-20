# SOAT Delivery Roadmap

The single cross-initiative view of **what is shipped, what is next, and what
depends on what** across every PRD in this directory. Each PRD owns the
fine-grained design and its own phase list; this page is the one place that
sequences them against each other.

Two initiatives keep a dedicated task-level roadmap for their internal
milestones — this page links to them rather than duplicating them:

- [Manage-by-Exception Roadmap](./manage-by-exception-roadmap.md) — approvals
  (G3) + guardrails (G4) + audit (M4) + activity (M5)
- [Usage Roadmap](./usage-roadmap.md) — usage metering (G5) + its downstream
  quota/guard consumers

> **Status is tracked here, not in the PRDs.** A PRD's `Implementation Status`
> table is a local convenience; when it disagrees with this page, this page
> wins. Shipped design sections stay in the PRDs (annotated `✅ Shipped`) as
> the design-of-record — see the [reconciliations](#cross-cutting-reconciliations)
> for PRDs whose bodies still describe a superseded design.

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

| G | Initiative | PRD | Status | Detail |
|---|-----------|-----|--------|--------|
| G1 | Schedules / triggers | Triggers module | 🟡 triggers exist; schedule wiring per umbrella | — |
| G2 | Queue-backed runs | [prd-orchestration-queue.md](./prd-orchestration-queue.md) | 🟡 durable runtime shipped; queue/idempotency/concurrency/SQS remain | — |
| G3 | Approvals · exceptions · activity | [prd-approvals.md](./prd-approvals.md) | 🟡 Phase 1 shipped | [MbE roadmap](./manage-by-exception-roadmap.md) |
| G4 | Guardrails · action classes | [prd-guardrails.md](./prd-guardrails.md) | ✅ core shipped (client-tool + orch tool-node gates remain) | [MbE roadmap M2](./manage-by-exception-roadmap.md) |
| G5 | Usage metering | [prd-usage-metering.md](./prd-usage-metering.md) | 🟡 Phases 1–3c shipped; infra emitters + guard integ. remain | [Usage roadmap](./usage-roadmap.md) |
| G6 | Learned-rules feedback loop | [prd-learned-rules.md](./prd-learned-rules.md) | ❌ Not started | — |
| G7 | Knowledge packages · context assembly | [prd-knowledge-packages.md](./prd-knowledge-packages.md) | ❌ Not started | — |

### Adjacent / standalone module PRDs

| Initiative | PRD | Status | Umbrella tie |
|-----------|-----|--------|--------------|
| Agent versions & staged rollout | [prd-agent-versions.md](./prd-agent-versions.md) | ❌ Not started | Part of umbrella (no G#) |
| Evaluations | [prd-evaluations.md](./prd-evaluations.md) | ❌ Not started | adjacent (gates agent-versions) |
| Audit log | [prd-audit-log.md](./prd-audit-log.md) | ❌ Not started | substrate for G3/G4 |
| Quotas | [prd-quotas.md](./prd-quotas.md) | ❌ Not started | Part of umbrella (no G#) |
| Model routing | [prd-model-routing.md](./prd-model-routing.md) | ❌ Not started | complements G2 |
| Memories | [prd-memories.md](./prd-memories.md) | 🟡 Phases 1–4 shipped; 5 partial; 6–9 remain | data plane |
| Knowledge (retrieval surface) | [prd-knowledge.md](./prd-knowledge.md) | 🟡 Phases 1,2,4 shipped; 3,5,6,7 remain | data plane |
| Discussions / reasoning engine | [prd-discussions.md](./prd-discussions.md) | 🟡 Phases 0–2,4,5 shipped; 3 partial | standalone |

## Status detail

**Shipped, extending:**

- **G2 orchestration-queue** — ✅ durable background execution, checkpoint
  crash recovery, no-worker parking (`sleeping`/`awaiting_input`), per-node
  retry with backoff, synchronous `wait: true` mode, run lifecycle webhooks.
  ❌ queue abstraction + Postgres driver + run-scoped idempotency keys (P1),
  per-project/global concurrency limits (P2), pluggable driver + SQS (P3).
- **G3 approvals** — ✅ `ApprovalItem` + lifecycle, `approval` orchestration
  node, server-side expiry (sweeper + resolution re-check), approve /
  reject-with-reason / edit-then-approve, lifecycle webhooks, REST/OpenAPI/
  permissions. Tool-call interception (the second producer) shipped as the
  **guardrail interceptor** under G4, not as a per-binding `approval_policy`.
  ❌ exceptions + severity routing (P3), activity feed (P4), approver
  targeting (P5).
- **G4 guardrails** — ✅ standalone `guardrails` resource + `GuardrailVersion`,
  classify→route interceptor, guard evaluation + application-owned context
  (`args.*`/`context.*`/`soat.*`), project/agent/tool attach with
  stricter-wins composition, tripwires + `escalate`, `guardrail_evaluation`
  audit record, dry-run `evaluate` endpoint; the per-binding `approval_policy`
  was deprecated and then removed. ❌ `requires_action` handoff gate for
  **client** tools, orchestration tool-node dispatch path, per-class default
  expiry.
- **G5 usage-metering** — ✅ event+component model, three-tier `PriceBook`
  with write-time cost, per-generation + per-run receipts, grouped aggregation
  (`GET /usage`), `UsageThreshold` + `usage.threshold_crossed` webhook.
  🚧 provider-call instrumentation covers agents/conversations/orchestration
  nodes; extraction/discussions/chats pending. ❌ compute (P4), storage (P5),
  api-request (P6) emitters. ⏭️ budget-guard integration (P7).
- **Memories** — ✅ storage + write algorithm v1, agent read/write, tags,
  automatic extraction. 🟡 write algorithm v2 (only LLM merge-consolidation
  shipped). ❌ entity graph (P6), streaming/client-tool extraction (P7),
  forgetting/decay (P8), profile memory (P9).
- **Knowledge** — ✅ unified `POST /knowledge/search`, chunk-level document
  search, memory source integration + ranking/merge, post-conversation
  extraction. ❌ entity-graph queries (P3), hybrid retrieval/RRF (P5),
  injection hardening (P6), eval harness (P7).
- **Discussions** — ✅ reasoning pipeline (`branches × rounds`), reflect/debate
  normalized onto it, trace + telemetry, Discussions resource (thin MVP),
  reasoning removed from agents. ⏭️ async pipeline generate, `reasoning.budget`
  guard.

**Not started:** learned-rules (G6), knowledge-packages (G7), agent-versions,
evaluations, audit-log, quotas, model-routing.

## Implementation dependency graph

Arrow = "needs before it can ship". Shipped nodes are marked ✅; they are the
foundations everything else builds on.

```
FOUNDATIONS (shipped)
  orchestration runtime ✅   usage metering P1–3c ✅   guardrails core ✅
  knowledge P1/2/4 ✅        memories P1–4 ✅           approvals P1 ✅

next, deps satisfied ──────────────────────────────────────────────────────
  quotas P1 ............................. (independent; can ship anytime)
  quotas P2 ◄── usage metering ✅ ....... (metering choke point exists)
  orchestration-queue P1 (queue + run-scoped idempotency keys)
  guardrails: client-tool gate, orch tool-node dispatch ◄── guardrails core ✅
  usage metering P4/P5/P6 (compute/storage/request emitters) ◄── P3b schema ✅

cross-initiative ──────────────────────────────────────────────────────────
  evaluations P2 (async) ◄── orchestration-queue P1
  audit-log P1 ─► audit-log P2 ◄── guardrails P3
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
| usage metering ✅ | quotas P2 | token/cost windows read the meter-write choke point |
| usage metering ✅ | guardrails `soat.usage.*` | budget guards read windowed usage sums |
| orchestration-queue P1 | evaluations P2 | async eval runs ride the RunTask queue |
| orchestration-queue P1 | usage metering exactly-once | run-scoped idempotency keys (metering already node-scopes its own) |
| guardrails ✅ | approvals routing | class-C routes into `ApprovalItem`; replaced per-binding `approval_policy` |
| guardrails P3 | audit-log P2 | `guardrail_evaluation` becomes one audit `detail` kind |
| guardrails A/B + audit-log | approvals P4 (activity feed) | feed labels autonomous class-A/B actions on the audit substrate |
| knowledge P3 ◄──► memories P6 | each other | knowledge owns entity *queries*; memories owns entity *data* + extraction |
| approvals ✅ + memories ✅ | learned-rules | captures rejection/edit signals; reuses pgvector similarity |
| knowledge-packages ◄──► learned-rules | each other | assembler injects active rules as one layer |
| evaluations P1 | agent-versions P3 | eval verdict is the promotion gate |
| — | model-routing | standalone; complements G2, no metering change |

## Recommended build order

Roughly the umbrella's own suggested order, refined by what has since shipped:

1. **Quotas P1** (independent) and **orchestration-queue P1** (queue +
   idempotency) — both unblock a fan-out and neither waits on anything.
2. **Quotas P2** — unblocked now that metering shipped; closes hard spend
   enforcement.
3. **Guardrails remaining gates** (client-tool, orch tool-node) and **usage
   infra emitters (P4–P6)** — pure extensions of shipped cores.
4. **Audit-log P1→P2** and **evaluations P1–P2** — the substrate the activity
   feed and agent-versions promotion gate need.
5. **Agent-versions**, **approvals P3/P4** (exceptions + activity feed).
6. **G6 learned-rules ↔ G7 knowledge-packages** — the feedback + doctrine loop,
   last because it consumes approvals, memories, and evaluations signals.
7. **Model-routing** and the deferred tails (SQS driver, budget-guard P7) as
   hardening.

## Cross-cutting reconciliations

Open consistency items the PRDs still carry — flagged here so the roadmap
stays the source of truth:

- **Guardrails PRD body is stale.** [prd-guardrails.md](./prd-guardrails.md)'s
  Data Model / Permissions / REST API / Key Concepts still describe the
  abandoned "guardrails as a `kind` on the IAM `policies` resource" design
  (`pol_`, `policies:*`, `PolicyVersion`, `ProjectPolicyOverride`, `rules[]`
  first-match). Five dated (2026-07) decision blockquotes at the top override
  it; the authoritative contract is
  [modules/guardrails.md](../packages/website/docs/modules/guardrails.md)
  (`guard_`, `guardrails:*`, `GuardrailVersion`, attach lists, single-`class`
  document). A cleanup pass should annotate the stale back-half `✅ Shipped —
  superseded` the way usage-metering's schema section now is.
- **Activity-feed ownership.** Both [prd-audit-log.md](./prd-audit-log.md)
  (`AuditEntry.detail`) and [prd-approvals.md](./prd-approvals.md) (`ActivityEntry`,
  `acte_`, Phase 4) describe an activity substrate. Audit-log claims to
  "provide the activity substrate approvals assumes" — settle which model owns
  the feed before either ships (drives approvals P4 / MbE M5).
- **`tool_ids` → `tool_bindings`.** The 2026-07 promotion to a canonical
  `tool_bindings` array (approvals §5) postdates the `tool_ids: [{ ref: … }]`
  shape still shown in [prd-agent-operations.md](./prd-agent-operations.md)'s
  End State YAML — update the example.
- **`PolicyVersion` reference.** [prd-learned-rules.md](./prd-learned-rules.md)
  cites the guardrails `PolicyVersion` pattern for `LearnedRuleVersion`;
  guardrails renamed it `GuardrailVersion`. Cosmetic, but update on next touch.
- **Usage metering coverage.** Extraction / discussions / chats LLM calls are
  not yet metered (G5 provider-call instrumentation 🚧) — a coverage gap, not a
  schema gap.
```

