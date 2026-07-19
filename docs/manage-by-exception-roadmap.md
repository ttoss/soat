# Manage-by-Exception Roadmap

The ordered task list for taking the manage-by-exception surface from
"approval queue for orchestrated runs" (shipped) to the full operating
model — approvals on *every* surface, action-class routing with per-project
B→C downgrade, a queryable audit trail, and a customer-facing activity feed.
Specs live in the referenced PRDs; this page only sequences the work.

**Primary PRD:** [prd-approvals.md](./prd-approvals.md)
**Related:** [prd-guardrails.md](./prd-guardrails.md) (action classes,
downgrade, project/agent/tool attach scopes), [prd-audit-log.md](./prd-audit-log.md)
(audit trail + activity substrate),
[prd-knowledge-packages.md](./prd-knowledge-packages.md) (knowledge version
in `generation.metadata` — the B.6 dependency),
[prd-learned-rules.md](./prd-learned-rules.md) (consumes rejection reasons),
[prd-agent-operations.md](./prd-agent-operations.md) (G3 umbrella).

## Shipped (baseline)

The approval-queue mechanics — the core of requirements 1–3 and the
surface-agnostic substrate of requirement 7 — are done and tested.
([prd-approvals.md Phase 1](./prd-approvals.md#3-implementation-phases)).

- ✅ `ApprovalItem` model (`apr_` prefix) with lifecycle
  `pending → approved | rejected | expired`; cross-run, cross-project — not
  scoped to a single run (`src/lib/approvals.ts`, `models/ApprovalItem.ts`)
- ✅ Full decision payload frozen at emit time: `proposed_action`,
  `reasoning`, `evidence`, `predicted_impact`, `expires_at`, plus provenance
  (`run_id`, `node_id`, `generation_id`, `agent_id`, `knowledge_version`,
  `policy_version`)
- ✅ Cross-project queue: `GET /api/v1/approvals` aggregates across all the
  principal's authorized projects; filters by `status` / `origin` /
  `expires_before`
- ✅ **Expiry is a hard gate in both directions** — a background sweeper
  (`approvalScheduler.ts`) flips overdue items to `expired`, and the
  resolution path re-checks `expires_at` (`409 APPROVAL_EXPIRED`), closing
  the sweep-vs-approve race (requirement 2)
- ✅ Approve / reject-with-reason / edit-then-approve (requirement 3);
  rejection reason preserved as a feedback signal
- ✅ `approval` orchestration node (producer #1): parks the run as
  `awaiting_input`, routes resolution down `approved` / `rejected` /
  `on_expired` edges — **fail-closed on stale data proven by the run taking
  the not-approved path** (`orchestrationEngine.ts`)
- ✅ Producer-agnostic `DecisionOutput` + `registerApprovalResumeHandler`;
  lifecycle webhooks `approvals.created` / `.approved` / `.rejected` /
  `.expired`
- ✅ REST + OpenAPI + permissions (`approvals:ListApprovals` /
  `GetApproval` / `ResolveApproval`), generated SDK/CLI/MCP surface, docs
  (`docs/modules/approvals.md`)

## Milestone 1 — Approvals on every surface (requirement 7)

> [prd-approvals.md Phase 2](./prd-approvals.md#3-implementation-phases).
> Depends on the baseline only. Extends the same queue from orchestrated
> (DAG) execution to chat sessions, direct generations, and MCP — the
> surfaces a DAG-resident gate never protects. Without it, "allow / ask /
> deny" holds only inside orchestration.

> **Docs-first:** the final user-facing contract is written ahead of the code —
> [agents.md — Tool Bindings / Approval Policy](../packages/website/docs/modules/agents.md)
> and [approvals.md — producers & return-pending](../packages/website/docs/modules/approvals.md).

| # | Task | Notes |
|---|------|-------|
| 1.0 | `tool_bindings` binding objects; deprecate `tool_ids` / `tools` | Canonical `[{ tool_id \| tool, approval_policy? }]` (the pipeline `steps[]` reference-or-inline pattern); shorthands normalize server-side and stay echoed (derived) in responses; formations `AgentResourceProperties` syncs the same field |
| 1.1 | `approval_policy` on the `tool_bindings` entry | JSON Logic over `{action, arguments}` → `allow` \| `require_approval` \| `deny`; evaluated in the platform tool-dispatch path (the resolver's `execute` wrap point), not by the model or the DAG; rejected on `client` bindings |
| 1.2 | Return-pending suspension for synchronous generations | Intercepted call returns `{status: "pending_approval", approval_id, expires_at}` as the tool result; the turn completes normally (no `requires_action` pause); `approval_*` justification fields injected into the model-visible schema and frozen onto the item |
| 1.3 | Continuation generation on resolution | Registered via `registerApprovalResumeHandler` (`origin: tool_call` guard, mirroring the node handler); new generation linked via `initiator_generation_id`; on approval the platform executes the frozen/edited args and populates `DecisionOutput.result` |
| 1.4 | Dedup / idempotency | Key over (project, agent, tool, action, args digest) while an item is `pending`; a duplicate emit returns the existing item (the `dedup_key` column + partial unique index already exist; the return-existing logic doesn't) |
| 1.5 | `origin: tool_call` wiring end-to-end | Same item model, endpoints, events; `origin` stays analytics-only — the lifecycle never branches on it |

## Milestone 2 — Action classes & B→C downgrade (requirement 5)

> [prd-guardrails.md Phases 1–3](./prd-guardrails.md#implementation-phases).
> The deterministic classify→route engine that decides *what* needs a human,
> plus project/agent/tool attach scopes that let a customer run a stricter
> posture (downgrade any class-B action to C) in one project without touching
> others. Supersedes Milestone 1's policy source: the guardrail becomes
> the **single** policy source for tool-call routing, replacing the per-binding
> `approval_policy` (deprecated task 2.7, removed task 2.8) while keeping M1's
> dispatch machinery.

> **Docs-first:** the final user-facing contract is written ahead of the code —
> [guardrails.md](../packages/website/docs/modules/guardrails.md) (a standalone
> `guardrails` resource: action classes, guards + application-owned guardrail
> context, tripwires, project/agent/tool attach scopes, versioning, evaluation audit record).
>
> **Placement decision (2026-07):** guardrails ship as a **first-class
> `guardrails` resource** (own `guard_` id, own `guardrails:*` permission
> namespace, own versioning), **not** as a `kind` discriminator on
> the IAM `policies` resource. Guardrails evaluate on a different layer (agent
> tool-dispatch, by arguments/context) than IAM policies (request auth, by
> principal), attach differently (`guardrail_ids` on the project/agent/tool, not
> user/key attachment), and keeping them separate leaves the security-critical
> IAM module untouched. Supersedes prd-guardrails.md's "reuses the policies module surface".
>
> **Context decision (2026-07):** guard context is **application-owned**, not a
> platform-computed provider catalog. Guards see three namespaces: `args.*`
> (call arguments), `context.*` (the effective guardrail context), `soat.*`
> (reserved platform catalog — identity, run state, usage, activity). The caller
> passes `guardrail_context` on the generation / orchestration-run request; a
> guardrail may name a `context_tool_id` called at evaluation time — solving the
> stale-context problem for long-lived runs — combined per `context_mode`
> (`merge` default, tool wins; or `replace`). Fail-closed throughout: a missing
> `context.*` key, a context-tool failure/timeout, or an unresolvable `soat.*`
> provider counts as a failed guard. Supersedes prd-guardrails.md's fixed
> `project.context.*` provider catalog.
>
> **Attachment decision (2026-07):** guardrails are the **single** tool-call
> gating mechanism. Projects, agents, and tools each carry a `guardrail_ids`
> **list**: a guardrail attaches at the **project** scope (baseline / central
> mandate — every call by every agent in the project), the **agent** scope
> (its whole tool surface), or the **tool** scope (every agent that uses it),
> and several composable guardrails (budget, PII, rate-limit) can apply to one
> call. Every guardrail that applies evaluates and the **strictest decision
> wins**; where more than one classifies the call as `B`, **all their guards
> must pass**. Composition is order-independent — `A` is the identity, so a
> guardrail that returns `A` defers to the rest.
>
> **Override decision (2026-07):** there is **no** `ProjectGuardrailOverride`
> resource. Because tools and agents are project-scoped and composition is
> stricter-wins, a per-project tighter posture is just a tighter guardrail
> attached at that project's (or its agents'/tools') scope — it can only
> tighten, and other projects are untouched. The project attach scope is the
> home for a central baseline a tenant can compose under but not loosen;
> adding to any `guardrail_ids` list needs only the carrying resource's
> update permission (attach can only tighten), while removing an id at **any**
> scope additionally requires `guardrails:DetachGuardrail`, so the floor
> can't be silently lowered. Supersedes the earlier
> "same document shape, evaluated alongside the template" override design.
>
> There is no per-tool `match` — a guardrail governs one tool surface and its
> single `class` JSON Logic expression decides the class from the call's
> arguments/context, so it is just `{ "class": "C" }` or an `if` over `args`.
> To gate several tools differently, attach a guardrail to each tool rather
> than branching on `soat.tool.name` inside one agent-level document. The per-binding `approval_policy` shipped in M1
> task 1.1 is **deprecated (task 2.7) and then removed entirely (task 2.8)**; M1's
> dispatch-path machinery (gate point, return-pending, continuation, dedup,
> justification fields) is retained as the guardrail interceptor — only the
> policy source changes.

| # | Task | Notes |
|---|------|-------|
| 2.1 | `guardrails` resource + action-class document schema/validation | Standalone resource (`guard_` id); versioned document of `{ class, default_class, guard?, escalate? }` — no rule list: `class` is a literal or a single JSON Logic expression (`if` over the call's `args` / `context`) returning the class, `guard` a single JSON Logic expression; invalid `class` result → `default_class` (C); own `guardrails:*` permissions. `DELETE` returns `409` while the id is referenced by any `guardrail_ids` (listing the referencing resources); a dangling reference at evaluation time fails closed (class C) |
| 2.2 | Tool-boundary interceptor: classify → route | Evaluate the `class` expression; **fail-closed default class C** on any invalid result (`null`, typo, non-class); class A/B execute autonomously (B iff its guard passes), class C routes to the approval queue (reusing M1's return-pending / continuation / dedup machinery), class D is blocked at dispatch (model gets a blocked tool result and continues); attach via a `guardrail_ids` list on the project (baseline), agent (whole surface), and/or tool (every agent); all applying guardrails evaluate → strictest decision wins (`blocked` > `tripwire` > `route_to_approval` > `execute`), and every `B` guard among them must pass. Adding an id needs only the resource's update permission; removing one at any scope requires `guardrails:DetachGuardrail` |
| 2.3 | Guard evaluation + guardrail context (`args.*` / `context.*` / `soat.*`) | Reuses the orchestration JSON Logic evaluator (no LLM in the path). Context is **application-owned**: the caller passes `guardrail_context` on the generation / run start; an optional `context_tool_id` on the guardrail is called at evaluation time (fresh data for long-lived runs) and combined per `context_mode` (`merge` default — tool wins; or `replace`). `soat.*` is the reserved platform-computed catalog. Fail-closed: missing keys, tool failure/timeout → guard failed |
| 2.4 | Project attach scope (`guardrail_ids` on the project) | No override resource: a per-project tighter posture is a guardrail attached at the project scope (baseline for every agent in the project), composing with agent/tool scopes by stricter-wins + guards-AND — tighten-only by construction. Downgrade B→C for one project leaves other projects unchanged (the acceptance criterion). Detach at any scope requires `guardrails:DetachGuardrail` (task 2.2), so the floor can't be silently lowered |
| 2.5 | Tripwires + `escalate` on a failing class-B guard | Default: abort the action and file an exception (a hard, non-LLM stop on a runaway loop). `escalate: true` opts into the softer path — a failing guard routes the call to the approval queue instead of aborting. Never a silent downgrade either way. `escalate` is per-guardrail: with several failing `B` guards the strictest decision still wins (`tripwire` outranks `route_to_approval`), so one guardrail's escalation never softens another's hard stop |
| 2.6 | `guardrail_evaluation` audit record | Every evaluation (execute / route-to-approval / block / tripwire) writes one activity entry per guardrail evaluated and stamps the generation/run record: governing `guardrail_version`, the `scope` it was attached at (`project` / `agent` / `tool`), resolved `class`, `decision`, `guard_result`, `context_source`, and a flat `context_snapshot` of **only the referenced vars** (fully-qualified `args.*` / `context.*` / `soat.*`), frozen at evaluation-time values |
| 2.7 | Deprecate per-binding `approval_policy` | Guardrails subsume it (a `{ "class": "C" }` guardrail on the tool is the migration path); mark the field deprecated in OpenAPI + docs, route all live tool-call gating through the guardrail interceptor, and stop honouring `approval_policy` as a routing source while leaving the field readable for one deprecation window |
| 2.8 | Remove `approval_policy` completely (breaking) | Terminal step after the deprecation window: delete the field from `tool_bindings` (server + model), its OpenAPI schema and validation, its dispatch-path evaluation branch, the formations `AgentResourceProperties` property, and the generated SDK/CLI surface; purge the deprecated-field docs (the `agents.md#approval-policy` section and the deprecation admonitions in `tools.md` / `approvals.md`). A `BREAKING CHANGE:` release notes guardrails as the sole tool-call gating mechanism. Only M1's shared dispatch machinery (return-pending, continuation, dedup, justification fields) remains — now solely the guardrail interceptor |
| 2.9 | Dry-run evaluate endpoint (`POST /guardrails/{guardrail_id}/evaluate`) | The adoption path — ships alongside 2.1–2.3, before customers attach at scale: runs the full pipeline (class expression, guard, context tool, live `soat.*`) over caller-supplied `args` / `guardrail_context` (+ optional `tool_id`) and returns the would-be `guardrail_evaluation` record; nothing executes, no approval item is filed, no activity entry is written. Also the preview path before editing a widely-attached guardrail (attachments track the id; edits apply everywhere immediately) |
| `[OPEN]` | Default expiry per action class | Briefing suggests 72h budget / 168h strategy — align with `action-classes.yaml`; today the `approval` node defaults to 24h |

## Milestone 3 — Knowledge-version provenance (B.6 dependency)

> Blocks the audit acceptance criterion. `knowledge_version` already exists
> as a column on `ApprovalItem` but is **never populated** — the
> `emitApproval` call in `orchestrationEngine.ts` doesn't pass it, and
> `generation.metadata` records no knowledge/playbook version.
> ([prd-knowledge-packages.md](./prd-knowledge-packages.md) supplies the
> versioned package; this milestone threads the version through.)

| # | Task | Notes |
|---|------|-------|
| 3.1 | Record `knowledge_version` on `generation.metadata` at emit time | The package/playbook version in context when the agent proposed the action |
| 3.2 | Stamp it onto `ApprovalItem` (and the audit record) | Pass `knowledgeVersion` / `policyVersion` through `emitApproval` from both producers |
| 3.3 | Join helper: run → generations → `knowledge_version` → approval | The one-place lookup the audit view (Milestone 4) reads |

## Milestone 4 — Audit trail (requirement 6)

> [prd-audit-log.md](./prd-audit-log.md). One append-only record for every
> Meta mutation, answering agent / evidence / knowledge version / approver /
> timestamp in one place. Depends on Milestone 3 for the knowledge version.

| # | Task | Notes |
|---|------|-------|
| 4.1 | `AuditEntry` model (append-only, `audit_` prefix) | No UPDATE/DELETE path enforced at the model layer |
| 4.2 | Post-commit write hook at the authorization choke point | Wraps `ctx.authUser.isAllowed`; fire-and-forget, bounded queue; the audit action string *is* the permission-action string |
| 4.3 | Read API `GET /api/v1/audit-log` + `/{entry_id}` | Filters: `action`, `actor_id`, `resource_srn`, `from` / `to`; `audit:ListAuditEntries` / `audit:GetAuditEntry` |
| 4.4 | Per-project export (also serves LGPD, §7) | Paginate the list endpoint into NDJSON; no dedicated export job in v1 |
| 4.5 | Retention sweep (`AUDIT_RETENTION_DAYS`) | Daily tick on the `orchestrationScheduler` interval pattern |

## Milestone 5 — Activity feed (requirement 4)

> [prd-approvals.md Phase 4](./prd-approvals.md#3-implementation-phases),
> built on the audit substrate. The customer-facing "what did the squad do
> today" surface — class-A/B autonomous actions, not raw execution logs.
> Depends on Milestone 2 (to label class A/B) and Milestone 4 (substrate).

| # | Task | Notes |
|---|------|-------|
| 5.1 | `ActivityEntry` feed (`acte_` prefix) | One entry per autonomously executed action; both producers write through the same module hook — or lands as one `detail` kind of `AuditEntry` (see prd-audit-log) |
| 5.2 | Cursor-paginated `GET /api/v1/activity` | Type / severity filters; chronological, per project |
| 5.3 | Evidence + drill-through linkage | Feed item → run → generations, with agent / node / guardrail-policy-version links (same evidence linkage as the queue) |
| 5.4 | Write `soat.activity.actions_24h` guard context | The platform-computed `soat.*` key Milestone 2 guards assume that nothing currently populates |

## Backlog (unsequenced)

- **Exceptions & severity routing**
  ([prd-approvals.md Phase 3](./prd-approvals.md#3-implementation-phases)):
  `ExceptionItem` auto-filed by exhausted retries, guardrail tripwires, and
  expired approvals; `info`/`warning`/`critical`; `open → acknowledged →
  resolved`; `exceptions.created` webhook. Feeds the activity/audit surfaces.
- **Learned-rules feedback loop** ([prd-learned-rules.md](./prd-learned-rules.md)):
  turn rejection reasons and edit diffs into candidate rules (PRD-004).
- **In-channel approval clients** (WhatsApp/Slack, §10.2): thin clients over
  the Layer-2 queue with first-class in-channel approve/reject.
- **Approver targeting & assignment**
  ([prd-approvals.md Phase 5](./prd-approvals.md#3-implementation-phases)):
  route specific items to specific humans; deferred until real demand.

## Dependency graph

```
baseline (approval queue + node + expiry, shipped)
   │
   ├─► M1 (tool-call approval on every surface)
   │        ▲
   │        │ guardrails replace approval_policy as the routing source
M2 (action classes + B→C downgrade) ──────────────┐
   │                                               │
M3 (knowledge version, B.6) ──► M4 (audit trail) ──┴─► M5 (activity feed)
```

M1 and M2 are independent of each other; M2 **supersedes** M1's policy source
— the per-binding `approval_policy` is deprecated (task 2.7) and then removed
entirely (task 2.8), while
M1's dispatch-path machinery survives as the guardrail interceptor. M3 is a small prerequisite that unblocks M4's
audit answer; M5 needs both M2 (class A/B labels) and M4 (the audit/activity
substrate).
