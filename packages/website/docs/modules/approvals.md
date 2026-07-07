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

### `human` vs `approval` — When to Use Which

`approval` builds on the `human` node's run-parking machinery but is **not** a
replacement for it. Keep `human` for arbitrary input; reach for `approval` only
when a human is signing off on a specific proposed action:

| You need to…                                                        | Use        |
| ------------------------------------------------------------------- | ---------- |
| Collect free-form or structured **data** into run state             | `human`    |
| Have a person **pick a branch** (`options` → a `condition` label)   | `human`    |
| Pause on a plain **continue? / yes-no** gate with nothing to run    | `human`    |
| Get sign-off on a **specific tool call** (approve / edit / reject)  | `approval` |
| Enforce **expiry**, snapshot **evidence**, or auto-**execute** on approve | `approval` |

The distinction is semantic, not just mechanical: `human` produces only run
state (nothing enumerates it across runs, carries evidence, or gates on
staleness — the gap this module closes), whereas `approval` promotes the
decision to product state with a queue, expiry, and execution. Modeling a data
prompt as an `approval` (there is no `proposed_action` to approve) or a refund
sign-off as a bare `human` node (no evidence, expiry, or execution) is a
mismatch in both directions.

> See the [Permissions Reference](../permissions.md) for the IAM action strings
> for this module.

## Data Model

### ApprovalItem

| Field                 | Type           | Description                                                          |
| --------------------- | -------------- | -------------------------------------------------------------------- |
| `id`                  | string         | Public identifier (`apr_…`)                                          |
| `project_id`          | string         | ID of the owning project (hard security boundary)                    |
| `status`              | `pending` \| `approved` \| `rejected` \| `expired` \| `superseded` | Lifecycle status |
| `proposed_action`     | object         | `{ tool_id, arguments }` — the action, frozen at emit time           |
| `reasoning`           | string \| null | Why the agent proposes this action                                   |
| `evidence`            | object \| null | Structured supporting data the approver decides on                   |
| `predicted_impact`    | string \| null | Expected effect if executed                                          |
| `expires_at`          | string         | Hard server-side gate; after this instant the item can never execute |
| `run_id` / `node_id`  | string \| null | Originating orchestration run and node; `null` for direct agent calls |
| `agent_id`            | string \| null | Proposing agent                                                      |
| `knowledge_version`   | string \| null | Knowledge package version in context, when present                   |
| `policy_version`      | string \| null | Guardrail policy version that routed here, when present              |
| `resolved_by`         | string \| null | Public ID of the user who resolved; `null` while `pending`/`expired` |
| `resolution_reason`   | string \| null | Required (non-null) on `rejected`                                    |
| `edited_arguments`    | object \| null | Set on edit-then-approve; the original stays in `proposed_action`    |
| `superseded_by`       | string \| null | Set when an edit escalated the action class; points at the replacement `apr_` item |
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
  `expired` and routes the run down its `expired` edge.
- The execution path re-checks expiry at resolution time, so a race can never
  execute an expired action.

Resolution is **single-shot**: only a `pending` item can be resolved. Any
resolve against an item already in a terminal state (`approved`, `rejected`,
`expired`, or `superseded`) returns `409` — so two humans racing to approve, or
a human approving an item the sweeper just expired, resolves deterministically
to the first writer.

### Resolving an Item

| Action              | Endpoint                                          | Rules                                                          |
| ------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| Approve             | `POST /api/v1/approvals/{approval_id}/approve`    | Records the decision and re-enqueues the run; see execution timing below |
| Edit-then-approve   | `POST /api/v1/approvals/{approval_id}/approve` with `arguments` | Edited args replace the proposal; the diff is preserved on the item |
| Reject              | `POST /api/v1/approvals/{approval_id}/reject`     | `reason` is **required**                                       |

Rejecting requires a reason and editing-then-approving preserves the diff —
both are capture hooks for the learning feedback loop.

**Execution timing.** `POST /approve` only records the decision (status →
`approved`) and re-enqueues the run; it returns immediately and does **not** run
the tool inside the HTTP request. The proposed action executes when the
scheduler next resumes the run, so its output is a property of run/node state
(the node's decision output `result`), not of the approve response. This keeps
arbitrary tool latency out of the request path and gives the action the run's
normal retry and tracing machinery. If the approved action ultimately fails, a
`run_failed` [exception](./exceptions.md) is filed and the run ends unless an
edge handles the failure — an `approved` item is never re-opened.

### Who May Resolve (v1)

Any principal with `approvals:ResolveApproval` in the project may resolve any of
that project's items — there is no per-item targeting or assignment in v1. The
guardrail policy decides *what* needs a human; the project policy layer decides
*who* counts as one. Targeted assignment (an `approver_policy` or an `assignees`
list stamped onto the item at emit time) is a planned future phase.

**Resolution requires a user principal.** The `/approve` and `/reject`
endpoints reject API-key authentication with `403` — only a logged-in user may
resolve. This is a transport-layer gate, not a policy convention: without it, an
agent whose project key carried `approvals:ResolveApproval` could approve its
own proposals through the MCP `approve-approval` tool, defeating the
human-in-the-loop gate the guardrail policy routed the action into.

### Edited Args Are Re-Validated and Re-Classified

On edit-then-approve, the edited arguments are:

1. **Re-validated** against the tool's input schema, and
2. **Re-classified** by the guardrail policy, exactly as a fresh proposal would
   be.

If the edited args classify to a **higher** action class than the original
proposal, the item cannot be resolved as-is: the resolve returns `409`, the
original item transitions to `superseded`, and a **new** `pending` item is
created for the edited proposal with the run re-parked on it. The `409` body
carries the new item's ID (also stored as `superseded_by` on the original).
Without this, editing an open item would be an approval-time
privilege-escalation path around the classifier.

### Origination: Runs and Direct Agent Calls

An approval item has two origination paths, which is why `run_id` / `node_id`
are nullable:

- **Orchestration run** — an `approval` node emits the item; resolving it
  re-enqueues the parked run and the decision output flows to downstream nodes.
- **Direct agent tool call** — the guardrail classifier routes a class-C tool
  call from an agent that is **not** running inside an orchestration. Here
  `run_id` / `node_id` are `null`; on `approved`, the agent's generation resumes
  through the existing tool-outputs mechanism, and on `rejected` / `expired` the
  call is reported back to the agent as a denied/expired result.

The REST/MCP surface and resolution rules are identical across both paths; only
the resume mechanism differs.

## The `approval` Orchestration Node

`approval` is a superset of the `human` node. See
[Orchestrations](./orchestrations.md) for how nodes and edges compose.

### Template Properties

Node `properties` are snake_case, consistent with other orchestration node
fields. `tool_id`, `arguments`, and `expires_in` are **required**; the rest are
optional. `expires_in` has no default — a template must set it, so no item is
ever emitted without an expiry gate.

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

## Example

An `approval` node inside an orchestration. The node **executes `tool_refund`
itself** when approved — its output lands in `gate.result` — so there is no
separate tool node; downstream nodes just consume the result. The unlabeled
edge is the `approved` path; `rejected` and `expired` are routed explicitly:

<Tabs groupId="client">
<TabItem value="sdk" label="TypeScript SDK">

```ts
import { createClient } from '@soat/sdk';

const soat = createClient({ baseUrl: process.env.SOAT_BASE_URL });

const { data, error } = await soat.orchestrations.createOrchestration({
  body: {
    project_id: 'proj_ABC',
    name: 'refund-with-approval',
    nodes: [
      {
        id: 'gate',
        type: 'approval',
        properties: {
          tool_id: { ref: 'tool_refund' },
          arguments: { amount: { var: 'refund.amount' } },
          expires_in: 86400,
          instructions: 'Approve refunds over $400.',
          reasoning: { var: 'refund.reason' },
        },
      },
      // Approved: the refund already ran inside `gate`; just confirm it.
      {
        id: 'notify_done',
        type: 'agent',
        agent_id: 'agent_xyz',
        input_mapping: { result: { var: 'gate.result' } },
      },
      // Rejected or expired: the refund never ran.
      { id: 'notify_denied', type: 'agent', agent_id: 'agent_xyz' },
    ],
    edges: [
      { from: 'gate', to: 'notify_done' },
      { from: 'gate', to: 'notify_denied', condition: 'rejected' },
      { from: 'gate', to: 'notify_denied', condition: 'expired' },
    ],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# List pending approvals for a project
curl -s "$SOAT_BASE_URL/api/v1/approvals?status=pending&project_id=proj_ABC" \
  -H "Authorization: Bearer $SOAT_TOKEN"

# Approve one (edit-then-approve by including arguments)
curl -s -X POST "$SOAT_BASE_URL/api/v1/approvals/apr_x1y2z3a4b5c6d7e8/approve" \
  -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "arguments": { "amount": 450 } }'

# Reject one (reason is required)
curl -s -X POST "$SOAT_BASE_URL/api/v1/approvals/apr_x1y2z3a4b5c6d7e8/reject" \
  -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Amount exceeds the customer refund cap." }'
```

</TabItem>
</Tabs>

## Webhook Events

The [webhooks](./webhooks.md) module gains approval event types so receivers can
route without polling:

| Event                | When                                       |
| -------------------- | ------------------------------------------ |
| `approvals.created`  | A new item is emitted onto the queue       |
| `approvals.resolved` | An item is approved, rejected, or edited   |
| `approvals.expired`  | The sweeper resolves an item as expired    |

## MCP Tools

The MCP tool surface (`list-approvals`, `get-approval`, `approve-approval`,
`reject-approval`) is derived automatically from the OpenAPI spec — external
assistants get the same queue surface as the product UI. The resolve tools stay
gated to user principals server-side, so an agent seeing `approve-approval`
cannot use it to self-approve.

## Related

- [Orchestrations](./orchestrations.md) — the `approval` node and run lifecycle
- [Exceptions](./exceptions.md) — expired approvals file an exception
- [Activity](./activity.md) — every resolution appears in the feed
