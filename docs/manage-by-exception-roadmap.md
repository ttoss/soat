# Manage-by-Exception Roadmap

The ordered task list for taking the manage-by-exception surface from
"approval queue for orchestrated runs" (shipped) to the full operating
model — approvals on *every* surface, action-class routing with per-project
B→C downgrade, a queryable audit trail, and a customer-facing activity feed.
Specs live in the referenced PRDs; this page only sequences the work.

**Primary PRD:** [prd-approvals.md](./prd-approvals.md)
**Related:** [prd-guardrails.md](./prd-guardrails.md) (action classes,
downgrade, per-project overrides), [prd-audit-log.md](./prd-audit-log.md)
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

| # | Task | Notes |
|---|------|-------|
| 1.1 | `approval_policy` on the agent↔tool binding | JSON Logic over resolved tool args → `allow` \| `require_approval` \| `deny`; evaluated in the platform tool-dispatch path, not by the model or the DAG |
| 1.2 | Return-pending suspension for synchronous generations | Intercepted call returns `{status: "pending_approval", approval_id, expires_at}` as the tool result; the turn completes normally |
| 1.3 | Continuation generation on resolution | Re-drive the session/conversation injecting the `DecisionOutput` as the tool result; on approval the platform executes the frozen/edited args and populates `result` |
| 1.4 | Dedup / idempotency | Key `(project_id, agent_id, tool_id, args_digest)` while an item is `pending`; a duplicate emit returns the existing item (the `dedup_key` column already exists) |
| 1.5 | `origin: tool_call` wiring end-to-end | Same item model, endpoints, events; `origin` stays analytics-only — the lifecycle never branches on it |

## Milestone 2 — Action classes & B→C downgrade (requirement 5)

> [prd-guardrails.md Phases 1–3](./prd-guardrails.md#implementation-phases).
> The deterministic classify→route engine that decides *what* needs a human,
> plus the per-project override that lets a customer downgrade any class-B
> action to C. Feeds Milestone 1: `action_classes` becomes the project-level
> policy source for tool-call routing.

| # | Task | Notes |
|---|------|-------|
| 2.1 | `kind: action_classes` discriminator on the policy resource | Existing `permissions` policies stay the default; versioned document of `{ match, class, guards, escalate }` rules |
| 2.2 | Tool-boundary interceptor: classify → route | First-match-wins; **fail-closed default class C**; class C routes to the approval queue, class A/B execute autonomously |
| 2.3 | Guard expression evaluation + named context providers | Reuses the orchestration JSON Logic evaluator (no LLM in the path); fixed key catalog `project.context.*` / `run.*` / `activity.*` / `usage.*` |
| 2.4 | Per-project overrides (`ProjectPolicyOverride`) | Layered over the template at evaluation time; **can tighten only** — downgrade B→C for one project leaves other projects unchanged (the acceptance criterion) |
| 2.5 | `escalate: true` downgrade-to-approval | A tripped guard files an exception or routes to the queue rather than silently downgrading |
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
| 5.4 | Write `activity.actions_24h` guard context | The context provider Milestone 2 guards assume that nothing currently populates |

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
   │        │ action_classes becomes the routing source
M2 (action classes + B→C downgrade) ──────────────┐
   │                                               │
M3 (knowledge version, B.6) ──► M4 (audit trail) ──┴─► M5 (activity feed)
```

M1 and M2 are independent of each other; M2 later refines M1's routing (a
per-binding `approval_policy` is the tactical form, `action_classes` the
project-level policy form). M3 is a small prerequisite that unblocks M4's
audit answer; M5 needs both M2 (class A/B labels) and M4 (the audit/activity
substrate).
