import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Approvals

Turn a human decision on an agent-proposed action into **product state**: a
persistent, queryable queue item that carries everything a person needs to
decide — and that can never execute once its evidence goes stale.

## Overview

An orchestration can already pause on a `human` node, but that pause is only run
state: nothing enumerates the pending decisions across every run, nothing
carries the evidence a decision needs, and nothing stops a stale decision from
executing weeks later.

The **approval** node upgrades the `human` node. When a run reaches it, the
platform freezes the proposed action and its context onto a self-contained
`ApprovalItem`, parks the run as `awaiting_input` (pure DB state, no worker),
and adds the item to a project-scoped queue. A human then **approves**,
**rejects** (with a required reason), or **edits-then-approves** — and the run
continues automatically down the matching edge.

This is manage-by-exception operation: agents propose, humans decide from a
queue, runs continue on their own.

> See the [Permissions Reference](../permissions.md) for the IAM action strings
> for this module.

## Data Model

### ApprovalItem

| Field                 | Type           | Description                                                          |
| --------------------- | -------------- | -------------------------------------------------------------------- |
| `id`                  | string         | Public identifier (`apr_…`)                                          |
| `project_id`          | string         | ID of the owning project (hard security boundary)                    |
| `status`              | `pending` \| `approved` \| `rejected` \| `expired` | Lifecycle status                        |
| `proposed_action`     | object         | `{ tool_id, arguments }` — the action, frozen at emit time           |
| `reasoning`           | string \| null | Why the agent proposes this action                                   |
| `evidence`            | object \| null | Structured supporting data the approver decides on                   |
| `predicted_impact`    | string \| null | Expected effect if executed                                          |
| `expires_at`          | string         | Hard server-side gate; after this instant the item can never execute |
| `run_id` / `node_id`  | string \| null | Originating orchestration run and node                               |
| `agent_id`            | string \| null | Proposing agent                                                      |
| `knowledge_version`   | string \| null | Knowledge package version in context, when present                   |
| `policy_version`      | string \| null | Guardrail policy version that routed here, when present              |
| `resolved_by`         | string \| null | Public ID of the user who resolved; `null` while `pending`/`expired` |
| `resolution_reason`   | string \| null | Required (non-null) on `rejected`                                    |
| `edited_arguments`    | object \| null | Set on edit-then-approve; the original stays in `proposed_action`    |
| `created_at`          | string         | ISO 8601 creation timestamp                                          |
| `updated_at`          | string         | ISO 8601 last-updated timestamp                                      |

Approval items are created **by the platform** (an `approval` node, or guardrail
routing) — there is no public create endpoint. They are listed and filtered via
`GET /api/v1/approvals` (by `status`, `project_id`, `expires_before`) and read
in full via `GET /api/v1/approvals/{approval_id}`.

## Key Concepts

### The Item Is Self-Contained

All of the node's mappings are resolved against run state and **frozen onto the
item at emit time**, together with provenance (`run_id`, `node_id`, `agent_id`,
and — where those subsystems are in play — `knowledge_version` and
`policy_version`). Later run-state changes never alter what the approver sees:
the approver decides on exactly the evidence the agent had, not on state that
drifted while the item sat in the queue.

### Expiry Is a Hard Gate

Evidence goes stale, so every item carries an `expires_at`. Expiry is enforced
server-side in **both** directions:

- A sweeper on the orchestration scheduler tick resolves overdue items as
  `expired` and routes the run down its `on_expired` edge.
- The execution path re-checks expiry at resolution time, so a race can never
  execute an expired action. Approving an already-expired item returns `409`.

### Resolving an Item

| Action              | Endpoint                                          | Rules                                                          |
| ------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| Approve             | `POST /api/v1/approvals/{approval_id}/approve`    | Executes the proposed action; the tool output is returned      |
| Edit-then-approve   | `POST /api/v1/approvals/{approval_id}/approve` with `arguments` | Edited args replace the proposal; the diff is preserved on the item |
| Reject              | `POST /api/v1/approvals/{approval_id}/reject`     | `reason` is **required**                                       |

Rejecting requires a reason and editing-then-approving preserves the diff —
both are capture hooks for the learning feedback loop.

### Edited Args Are Re-Validated and Re-Classified

On edit-then-approve, the edited arguments are:

1. **Re-validated** against the tool's input schema, and
2. **Re-classified** by the guardrail policy, exactly as a fresh proposal would
   be.

If the edited args classify to a **higher** action class than the original
proposal, the item cannot be resolved as-is: the resolve returns `409` and a
**new** approval item is created for the edited proposal. Without this,
editing an open item would be an approval-time privilege-escalation path around
the classifier.

### Who May Resolve (v1)

Any principal with `approvals:ResolveApproval` in the project may resolve any of
that project's items — there is no per-item targeting or assignment in v1. The
guardrail policy decides *what* needs a human; the project policy layer decides
*who* counts as one. Targeted assignment (an `approver_policy` or an `assignees`
list stamped onto the item at emit time) is a planned future phase.

## The `approval` Orchestration Node

`approval` is a superset of the `human` node. See
[Orchestrations](./orchestrations.md) for how nodes and edges compose.

### Template Properties

Node `properties` are snake_case, consistent with other orchestration node
fields:

| Property           | Type            | Description                                                                       |
| ------------------ | --------------- | --------------------------------------------------------------------------------- |
| `tool_id`          | string          | The tool the proposed action would invoke (`{ ref: … }` in formations)            |
| `arguments`        | object          | JSON Logic mappings over run state; resolved at emit time into `proposed_action.arguments` |
| `expires_in`       | integer         | Seconds until expiry; `expires_at = emitted_at + expires_in`                       |
| `instructions`     | string \| null  | Optional guidance shown to the approver; stored on the item                       |
| `reasoning`        | object \| null  | Optional JSON Logic mapping resolved into the item's `reasoning`                   |
| `evidence`         | object \| null  | Optional JSON Logic mapping resolved into the item's `evidence`                    |
| `predicted_impact` | object \| null  | Optional JSON Logic mapping resolved into the item's `predicted_impact`           |

### Edge Routing

Edges leaving an `approval` node may carry
`condition: "approved" | "rejected" | "expired"` — the same label-matching
mechanism `condition` nodes use for branch routing:

- An **unlabeled** edge is followed only on `approved` — the happy path is the
  common case, so rejection and expiry paths must be modeled explicitly.
- If the decision is `rejected` or `expired` and no edge matches its label, the
  run ends at the node.
- An `expired` decision additionally files an `approval_expired`
  [exception](./exceptions.md).

### Decision Output

When resolved, the node completes with a decision artifact that downstream nodes
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
- `result` — on `approved`, the node re-checks expiry and executes the proposed
  action (edited args if present) and `result` carries the tool output; `null`
  on `rejected`/`expired`

## Webhook Events

The [webhooks](./webhooks.md) module gains approval event types so receivers can
route without polling:

| Event               | When                                    |
| ------------------- | --------------------------------------- |
| `approvals.created` | A new item is emitted onto the queue    |
| `approvals.expired` | The sweeper resolves an item as expired |

## MCP Tools

The MCP tool surface (`list-approvals`, `approve-approval`, `reject-approval`)
is derived automatically from the OpenAPI spec — external assistants get the
same queue surface as the product UI.

## Related

- [Orchestrations](./orchestrations.md) — the `approval` node and run lifecycle
- [Exceptions](./exceptions.md) — expired approvals file an exception
- [Activity](./activity.md) — every resolution appears in the feed
