# PRD: Approvals, Exceptions & Activity Feed

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G3).
> Consumes run-parking from the existing orchestration `human` node machinery;
> feeds [prd-learned-rules.md](./prd-learned-rules.md) (rejection reasons and
> edits are the raw material of the feedback loop) and receives items from
> [prd-guardrails.md](./prd-guardrails.md) (class-C tool calls).

## Implementation Status

| Component                                   | Status         | Notes                                                                    |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| `ApprovalItem` model + lifecycle            | ❌ Not started | `apr_` prefix; proposed action + evidence + expiry                        |
| `approval` orchestration node type          | ❌ Not started | Upgrade of the `human` node: emits an item, parks the run                 |
| Server-side expiry enforcement              | ❌ Not started | Sweeper on the existing scheduler tick; expired items can never execute   |
| Approve / reject / edit-then-approve        | ❌ Not started | Rejection requires a reason                                               |
| `ExceptionItem` model + severity routing    | ❌ Not started | `exc_` prefix; anomalies, guard breaches, failed runs                     |
| `ActivityEntry` feed                        | ❌ Not started | `acte_` prefix; every autonomous execution is visible                     |
| Webhook events (`approvals.*`, `exceptions.*`) | ❌ Not started | Existing webhooks module gains the new event types                        |
| REST endpoints + OpenAPI + permissions      | ❌ Not started | MCP tools (`list-approvals`, `approve`, …) derive from the OpenAPI spec   |

## Implementation Phases

### Phase 1 — Approval Items + `approval` Node + Expiry ❌ Not started

**Goal:** A risky action proposed inside a run becomes a persistent, queryable
queue item with everything a human needs to decide — and it can never execute
after its evidence goes stale.

**Deliverables:**

- `ApprovalItem` model and `src/lib/approvals.ts`
- Orchestration node type `approval` (superset of `human`): emits an
  `ApprovalItem` carrying the proposed action and context, parks the run as
  `awaiting_input` (no worker, pure DB state — existing machinery)
- Resolution re-enqueues the run with the decision in the node output;
  `on_expired` edge routing (default: end the run + file an exception)
- Expiry sweeper on the existing scheduler tick; expiry is enforced
  server-side at resolution *and* execution time — an expired item returns
  `409` on approve and is never executed late
- Approve / reject (reason **required**) / edit-then-approve (the edited args
  replace the proposal; the diff is preserved on the item; edited args are
  re-validated and re-classified — see
  [Edited Args Are Re-Validated](#edited-args-are-re-validated-and-re-classified))
- REST CRUD/resolution endpoints, OpenAPI, permissions, SDK/CLI regeneration,
  module docs

**Unlocks:** Manage-by-exception operation: agents propose, humans decide from
a queue, runs continue automatically.

### Phase 2 — Exceptions + Severity Routing ❌ Not started

**Goal:** Failures, anomalies, and guardrail breaches are first-class items,
not log lines.

**Deliverables:**

- `ExceptionItem` model; filed automatically by: runs that exhaust node
  retries, guardrail tripwires ([prd-guardrails.md](./prd-guardrails.md)),
  expired approvals, and an explicit `file-exception` operation for agents
  and orchestration nodes
- Severity levels (`info` \| `warning` \| `critical`); resolution lifecycle
  (`open → acknowledged → resolved`) with notes
- Webhook events: `approvals.created`, `approvals.expired`,
  `exceptions.created` — payload includes severity so receivers can fan
  `critical` items into an operator channel while routine items go to the
  product queue

**Unlocks:** Hybrid alert routing (customer queue + operator escalation)
without polling.

### Phase 3 — Activity Feed ❌ Not started

**Goal:** Every autonomous execution is visible after the fact, so autonomy
stays auditable.

**Deliverables:**

- `ActivityEntry` model: one entry per autonomously executed action
  (guardrail class B), per approval resolution, per exception, per schedule
  fire — a project-scoped, append-only feed
- `GET /api/v1/activity` with cursor pagination and type/severity filters
- Entries link back to their run, node, agent, and (where applicable) the
  guardrail policy version that allowed the action

**Unlocks:** The "what did the agents do today" surface — thin clients render
the feed directly from REST/MCP.

### Phase 4 — Approver Targeting & Assignment ❌ Future

**Goal:** Route specific items to specific humans, on top of the v1
any-resolver model (see [Who May Resolve (v1)](#who-may-resolve-v1)).

**Sketch (not committed):** optional `approver_policy` (a policy the resolver
must additionally satisfy) or an `assignees` list on the `approval` node,
snapshotted onto the item at emit time and enforced server-side at
resolution; `approvals.created` webhook payload gains the target so receivers
can notify the right person.

## Overview

Orchestrations can already pause on a `human` node, but the pause is only run
state: nothing enumerates pending decisions across runs, nothing carries the
evidence a decision needs, and nothing stops a stale decision from executing
weeks later. This module makes human decisions **product state**: approval
queues with expiry, exception queues with severity, and an activity feed —
all per project, all queryable via REST/MCP, all pushed via webhooks.

## Key Concepts

### Approval Item

The unit of human decision. Carries the **proposed action** (tool + args), the
**reasoning and evidence** the proposing agent supplied, a **predicted
impact** summary, and an **expiry**. Provenance links it to the originating
run, node, agent, and the knowledge/policy versions in play
([prd-knowledge-packages.md](./prd-knowledge-packages.md),
[prd-guardrails.md](./prd-guardrails.md)) — one query answers "who proposed
what, based on which knowledge, and who approved it".

### Expiry Is a Hard Gate

Evidence goes stale. Expiry is enforced server-side in both directions: the
sweeper resolves overdue items as `expired` (routing the run down its
`on_expired` edge), and the execution path re-checks expiry so a race can
never execute an expired action.

### Rejection Reasons Feed Learning

Rejecting requires a reason; editing-then-approving preserves the diff. Both
are capture hooks for [candidate rules](./prd-learned-rules.md) — the feedback
loop starts here.

### The `approval` Node — Template Schema

The node's template-facing `properties` (snake_case, consistent with existing
orchestration node fields):

| Property           | Type            | Description                                                                 |
| ------------------ | --------------- | ---------------------------------------------------------------------------- |
| `tool_id`          | string          | The tool the proposed action would invoke (`{ ref: ... }` in formations)      |
| `arguments`        | object          | JSON Logic mappings over run state; resolved at emit time into `proposed_action.arguments` |
| `expires_in`       | integer         | Seconds until expiry; `expires_at = emitted_at + expires_in`. Decision: an integer of seconds (not a duration string) — matches `grace_seconds` on schedules and needs no parser |
| `instructions`     | string \| null  | Optional guidance shown to the approver; stored on the item                   |
| `reasoning`        | object \| null  | Optional JSON Logic mapping resolved into the item's `reasoning`              |
| `evidence`         | object \| null  | Optional JSON Logic mapping resolved into the item's `evidence`               |
| `predicted_impact` | object \| null  | Optional JSON Logic mapping resolved into the item's `predicted_impact`       |

**Snapshot semantics:** all mappings are resolved against the run state and
frozen onto the `ApprovalItem` at emit time, together with provenance
(`run_id`, `node_id`, `agent_id`, `knowledge_version`, `policy_version`)
stamped by the platform. The item is self-contained — later run-state changes
never alter what the approver sees. Decision: snapshot-at-emit, because the
approver must decide on exactly the evidence the agent had, not on state that
drifted while the item sat in the queue.

**`on_expired` edge semantics:** edges leaving an `approval` node may carry
`condition: "approved" | "rejected" | "expired"` — the same label-matching
mechanism `condition` nodes already use for branch routing. An unlabeled edge
follows only on `approved` (decision: the happy path is the common case;
rejection and expiry paths must be modeled explicitly). If the decision is
`rejected` or `expired` and no edge matches its label, the run ends at the
node; `expired` additionally files an `approval_expired` `ExceptionItem`
(the Phase 1 default).

### Decision Output

The node completes with a decision artifact — the shape downstream nodes
consume via `input_mapping` (snake_case, like every run/REST payload):

```json
{
  "decision": "approved",
  "approval_id": "apr_x1y2z3a4b5c6d7e8",
  "resolved_by": "user_a1b2c3d4e5f6g7h8",
  "edited_args": { "amount": 450 },
  "reason": null,
  "result": { "status": "ok" }
}
```

- `decision` — `approved` \| `rejected` \| `expired`
- `resolved_by` — resolving user's public ID; `null` on `expired`
- `edited_args` — `null` unless edit-then-approve
- `reason` — required (non-null) on `rejected`; optional otherwise
- `result` — on `approved`, the node re-checks expiry and executes the
  proposed action (edited args if present), and `result` carries the tool
  output; `null` on `rejected`/`expired`

### Edited Args Are Re-Validated and Re-Classified

On edit-then-approve, the edited arguments are (1) re-validated against the
tool's input schema and (2) re-classified by the guardrail policy
([prd-guardrails.md](./prd-guardrails.md)) exactly as a fresh proposal would
be. If the edited args classify to a **higher** action class than the original
proposal, the item cannot be resolved as-is — the resolve returns `409` and a
**new** approval item is created for the edited proposal. Rationale: without
re-classification, editing an open item would be an approval-time privilege
escalation path around the classifier.

### Who May Resolve (v1)

Decision: in v1, **any principal with `approvals:ResolveApproval` in the
project** may resolve any of the project's items — there is no per-item
targeting or assignment. This is deliberate: the guardrail policy decides
*what* needs a human, and the existing project policy layer decides *who*
counts as one — no new authorization concept until real demand.

Targeting/assignment is a listed future phase
([Phase 4](#phase-4--approver-targeting--assignment--future)): an optional
`approver_policy` (policy ref that the resolver must additionally satisfy) or
an `assignees` list on the `approval` node, stamped onto the item at emit
time and enforced at resolution.

## Data Model

### ApprovalItem

| Field                | Type           | Description                                                       |
| -------------------- | -------------- | ------------------------------------------------------------------ |
| `id`                 | string         | Public ID (`apr_` prefix)                                          |
| `project_id`         | string         | Owning project                                                     |
| `status`             | string         | `pending` \| `approved` \| `rejected` \| `expired`                 |
| `proposed_action`    | object         | `{ tool_id, arguments }`                                           |
| `reasoning`          | string \| null | Why the agent proposes this                                        |
| `evidence`           | object \| null | Structured supporting data                                         |
| `predicted_impact`   | string \| null | Expected effect if executed                                        |
| `expires_at`         | string         | Hard server-side gate                                              |
| `run_id` / `node_id` | string \| null | Originating orchestration run/node                                 |
| `agent_id`           | string \| null | Proposing agent                                                    |
| `knowledge_version`  | string \| null | Knowledge package version in context ([G7](./prd-knowledge-packages.md)) |
| `policy_version`     | string \| null | Guardrail policy version that routed here ([G4](./prd-guardrails.md)) |
| `resolved_by`        | string \| null | User who resolved                                                  |
| `resolution_reason`  | string \| null | Required on `rejected`                                             |
| `edited_arguments`   | object \| null | Set on edit-then-approve; original preserved in `proposed_action`  |
| `created_at` / `updated_at` | string  |                                                                    |

### ExceptionItem

| Field         | Type           | Description                                            |
| ------------- | -------------- | ------------------------------------------------------- |
| `id`          | string         | Public ID (`exc_` prefix)                               |
| `project_id`  | string         | Owning project                                          |
| `status`      | string         | `open` \| `acknowledged` \| `resolved`                  |
| `severity`    | string         | `info` \| `warning` \| `critical`                       |
| `kind`        | string         | `run_failed` \| `guardrail_tripwire` \| `approval_expired` \| `manual` |
| `title` / `detail` | string    | Human-readable description + structured detail          |
| `run_id` / `node_id` / `agent_id` | string \| null | Provenance                          |
| `resolved_by` / `resolution_note` | string \| null | Resolution audit                    |
| `created_at` / `updated_at` | string |                                                        |

### ActivityEntry

| Field        | Type           | Description                                                      |
| ------------ | -------------- | ----------------------------------------------------------------- |
| `id`         | string         | Public ID (`acte_` prefix)                                        |
| `project_id` | string         | Owning project                                                    |
| `kind`       | string         | `action_executed` \| `approval_resolved` \| `exception_created` \| `schedule_fired` |
| `summary`    | string         | One-line description                                              |
| `detail`     | object \| null | Structured payload (tool, args digest, policy version, …)         |
| `run_id` / `agent_id` / `ref_id` | string \| null | Provenance; `ref_id` points at the approval/exception/schedule |
| `created_at` | string         | Append-only; no update path                                       |

Indexes: `(project_id, status, expires_at)` on ApprovalItem;
`(project_id, status, severity)` on ExceptionItem;
`(project_id, created_at DESC)` on ActivityEntry.

## Permissions

| Permission                        | Endpoint                                          |
| --------------------------------- | -------------------------------------------------- |
| `approvals:ListApprovals`         | `GET /api/v1/approvals`                            |
| `approvals:GetApproval`           | `GET /api/v1/approvals/{approval_id}`                |
| `approvals:ResolveApproval`       | `POST /api/v1/approvals/{approval_id}/approve` and `/reject` |
| `exceptions:ListExceptions`       | `GET /api/v1/exceptions`                           |
| `exceptions:ResolveException`     | `POST /api/v1/exceptions/{exception_id}/resolve`     |
| `activity:ListActivity`           | `GET /api/v1/activity`                             |

Approval items are created by the platform (approval nodes, guardrail
routing), not via a public create endpoint.

## REST API

| Method | Path                                       | Description                                          |
| ------ | ------------------------------------------ | ---------------------------------------------------- |
| GET    | `/api/v1/approvals`                        | List/filter (`status`, `project_id`, `expires_before`) |
| GET    | `/api/v1/approvals/{approval_id}`            | Get one item with full evidence                       |
| POST   | `/api/v1/approvals/{approval_id}/approve`    | Approve; optional `arguments` for edit-then-approve (re-validated + re-classified) |
| POST   | `/api/v1/approvals/{approval_id}/reject`     | Reject; `reason` required                             |
| GET    | `/api/v1/exceptions`                       | List/filter (`status`, `severity`)                    |
| POST   | `/api/v1/exceptions/{exception_id}/resolve`  | Acknowledge/resolve with a note                       |
| GET    | `/api/v1/activity`                         | Project activity feed, cursor-paginated               |

MCP tools (`list-approvals`, `approve-approval`, `reject-approval`,
`list-exceptions`, `resolve-exception`, `list-activity`) derive automatically
from the OpenAPI spec — external assistants get the same queue surface as the
product UI.
