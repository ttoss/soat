---
description: "Human-decision approval queue with frozen evidence and server-enforced expiry in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Approvals

A queue of human decisions. When an agent proposes a risky action, the platform
files an **approval item** with the frozen proposed action, supporting evidence
and a hard expiry; a human approves, edits-then-approves, or rejects it.

## Overview

Approvals are producer-agnostic: one item model, one expiry path, one decision
output shape. Items are **created by the platform only**; there is no public
create endpoint. Producers:

- the [`approval` orchestration node](./orchestrations.md) (`origin: node`);
- **tool-call interception**: a [guardrail](./guardrails.md) on a project,
  agent, or tool gates tool calls in chat sessions, direct generations and MCP
  (`origin: tool_call`);
- **approval-gated task transitions**: a workflow transition declaring
  [`requires_approval`](./workflows.md#approval-gated-transitions)
  (`origin: task_transition`). The item carries no `proposed_action`; it gates
  the transition named by `task_transition` on `task_id`.

`origin` is for filtering only; the lifecycle never branches on it.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Approval Gates - Step 7 (Approve it — the run resumes)](/docs/tutorials/approval-gate#step-7--approve-it--the-run-resumes)
- [Gate a Dangerous Tool with Guardrails - Step 9 (A class-C call parks for sign-off)](/docs/tutorials/gate-a-tool-with-guardrails#step-9--class-c-the-run-parks-for-sign-off)
- [Close the Monthly Books - Step 11 (Sign off: the human decides, the guard has the last word)](/docs/tutorials/close-the-monthly-books#step-11--sign-off-the-human-decides-the-guard-has-the-last-word) — a `requires_approval` transition item.

## Data Model

| Field                | Type            | Description                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `id`                 | string          | Public identifier (`apr_…`)                                        |
| `project_id`         | string          | ID of the owning project                                           |
| `origin`             | string          | `node` \| `tool_call` \| `task_transition` — producer origin (analytics/filtering only) |
| `status`             | string          | `pending` \| `approved` \| `rejected` \| `expired`                 |
| `proposed_action`    | object \| null  | Frozen `{ tool_id, action?, arguments }` the decision governs; `null` for `task_transition` items. `action` is present for `tool_call`-origin items (always, even for single-action tools) and omitted for `node`-origin items, whose downstream execution is wired by a separate `tool` node in the graph |
| `reasoning`          | string \| null  | The proposing agent's rationale                                    |
| `evidence`           | object \| null  | Structured supporting data                                         |
| `predicted_impact`   | string \| null  | Expected execution effect                                          |
| `expires_at`         | string          | Server-enforced hard gate; the item can never execute after this   |
| `dedup_key`          | string \| null  | Set on tool-call items to suppress duplicate proposals             |
| `orchestration_run_id`             | string \| null  | Originating orchestration run (node producer)                      |
| `node_id`            | string \| null  | Originating node id within the run's graph                         |
| `generation_id`      | string \| null  | Originating generation (tool-call producer)                        |
| `session_id`         | string \| null  | Session the originating generation ran in (tool-call producer)     |
| `agent_id`           | string \| null  | Proposing agent                                                    |
| `task_id`            | string \| null  | Gated task (`task_transition` producer)                            |
| `task_transition`    | string \| null  | Transition fired on approval (`task_transition` producer)          |
| `policy_version`     | string \| null  | Guardrail policy version that routed here                          |
| `previous_item_id`   | string \| null  | Prior item's ID when this proposal was re-filed after an earlier matching item (same `dedup_key`) was rejected |
| `resolved_by`        | string \| null  | Resolving user's public ID; `null` on expiry                       |
| `resolution_reason`  | string \| null  | Required on rejection                                              |
| `edited_arguments`   | object \| null  | Set on edit-then-approve; the original stays in `proposed_action`  |
| `created_at`         | string          | ISO 8601 creation timestamp                                        |
| `updated_at`         | string          | ISO 8601 last-updated timestamp                                    |

## Key Concepts

### Snapshot at emit time

`proposed_action`, `reasoning`, `evidence` and `predicted_impact` are resolved
at emit time and **frozen** onto the item; later state changes never alter what
the approver sees.

### How producers suspend and resume

- **`approval` node: the run parks.** The node emits the item and parks the
  run as `awaiting_input`. Resolution re-enqueues the run with the
  [decision output](#decision-output) as the node result, routing
  `approved` / `rejected` / `on_expired` edges.
- **Task transition: the gate parks.** The transition files the item and sets
  `pending_transition` on the task; no other transition may fire until it
  resolves. Approval fires the transition as the `approval` principal (guard
  re-evaluated then); rejection or expiry clears the gate and appends a note to
  the task's history. See [Workflows](./workflows.md#approval-gated-transitions).
- **Tool-call interception: return-pending.** The intercepted call files the
  item and returns
  `{ "status": "pending_approval", "approval_id": "apr_…", "expires_at": "…" }`
  as the **tool result**; the generation completes its turn. On resolution the
  platform starts a **continuation generation** (linked via
  `initiator_generation_id`) feeding the decision output back to the agent. On
  approval the frozen (or edited) arguments execute first and the tool's output
  becomes the decision's `result`; on rejection nothing executes. **Expiry ends
  the chain** unless the agent sets `on_approval_expiry: "react"`, in which case
  the continuation carries `{ "decision": "expired" }` (see
  [Agents → Approval Expiry](./agents.md#approval-expiry)); the `expired` row,
  the `approvals.expired` event and the auto-filed exception are the record.
  When the original generation ran in a session or conversation, the
  continuation's messages append there.
- **The continuation runs the agent's own config**, including
  [`tool_choice`](./agents.md#tool-choice): a forcing agent reports the
  decision by reaching its `has_tool_call`
  [stop condition](./agents.md#stop-conditions), which is why that condition is
  mandatory for it.

### Continuation identity

A continuation runs **as the principal that started the chain**, never as the
approver. The platform reads the principal persisted on the proposing
generation
([`started_by_principal_type` / `started_by_principal_id`](./generations.md#starting-principal))
and re-mints a short-lived run-as token; the continuation's
[`builtin` tools](./tools.md#builtin) and the approved action execute with it.
The token asserts identity only; authorization is evaluated per request, so a
chain started by a scoped API key never exceeds that key's policies, and
revoking the key stops the chain mid-flight.

The continuation records the same principal on its own generation, so later
approvals in the chain re-mint from there. A chain with no recorded principal
(started by a trigger or an OAuth token) gets no credential; its self-calls
stay unauthenticated.

### Duplicate proposals (dedup)

Tool-call items carry a `dedup_key` derived from agent, tool, action and
resolved arguments. While a matching item is `pending`, a duplicate emit
returns the existing item (its `approval_id` in the tool result). Once it
resolves, the same proposal files a fresh item; after a **rejected** one, the
fresh item's `previous_item_id` links back to it. Node-produced items are not
deduplicated; each run pauses once per `approval` node.

### Recurrence view

[`GET /api/v1/approvals/recurrences`](/docs/api/approvals/list-approval-recurrences)
is a **read-only** rollup grouping items by `dedup_key`, most-recurrent first.
Each group carries `agent_id`, `tool_id`, `count`, the ordered item `chain`
(the `previous_item_id` thread, oldest → newest), and `reasons` in order.

- `status` (default `rejected`) selects the lifecycle state grouped.
- `min_count` (default `2`) is the floor for a group to be returned.
- Grouping is **exact-key only**; no semantic clustering.

A recurring correction belongs in a [guardrail](./guardrails.md) `deny` or the
agent's `instructions`
([agent versions](./agents.md#versioning-and-staged-rollout) archive every
write), not in [memories](./memories.md#what-belongs-in-a-memory).

### Expiry is a hard gate

Expiry is enforced server-side in **both directions**:

- A background sweeper flips overdue `pending` items to `expired` and emits
  `approvals.expired`.
- The resolution path re-checks `expires_at` at decision time; an expired item
  returns `409 APPROVAL_EXPIRED` and never executes.

### Approve, reject, edit-then-approve

- **Approve** resolves the item and resumes its producer: an `approval` node
  routes down its `approved` edge (a downstream `tool` node acts on the
  arguments); a tool-call item has its arguments executed by the platform, the
  result flowing into the
  [continuation generation](#how-producers-suspend-and-resume).
- **Edit-then-approve** replaces the arguments via `arguments` on the approve
  call. They must be a JSON object satisfying the tool's `parameters` schema
  (`400 APPROVAL_INVALID_EDIT` otherwise); the original stays in
  `proposed_action`, the edit in `edited_arguments`. Editing needs more
  authority; see [Who may resolve](#who-may-resolve).
- **Reject** requires a `reason`, preserved on the item.

### Decision output

The `approval` node consumes the decision as its node result; a tool-call
continuation as the tool result. Same shape:

```json
{
  "decision": "approved",
  "approval_id": "apr_x1y2z3a4b5c6d7e8",
  "resolved_by": "user_a1b2c3d4e5f6g7h8",
  "edited_args": { "amount": 450 },
  "reason": null,
  "result": null
}
```

- `decision` — `approved` \| `rejected` \| `expired`
- `resolved_by` — resolving user's public ID; `null` on expiry
- `edited_args` — `null` unless edit-then-approve
- `reason` — required (non-null) on rejection
- `result` — the executed tool output on approval for `tool_call` items;
  `null` for `node` items (execution belongs to the downstream `tool` node)

### Who may resolve

Any principal with `approvals:ResolveApproval` in the project may resolve any
of its items; there is no per-item assignment.

**Editing the arguments takes more than resolving**, since the approved action
executes under the **proposing** generation's principal. An edit additionally
requires what making the call would require:

| Proposal | Also required to edit |
| --- | --- |
| any tool | `tools:CallTool` on that tool |
| a `builtin` tool | the proposed action's own IAM action, anywhere in the project |

A builtin action is dispatched in-process against the proposer's credential, so nothing else checks the approver. An edit failing either check answers `403 FORBIDDEN`; approving as proposed is unaffected.

## Examples

### List pending approvals

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-approvals --project-id proj_ABC --status pending
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.approvals.listApprovals({
  query: { project_id: 'proj_ABC', status: 'pending' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET "https://api.example.com/api/v1/approvals?project_id=proj_ABC&status=pending" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Approve (optionally with edited arguments)

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat approve-approval --approval-id apr_01 --arguments '{"amount": 450}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.approvals.approveApproval({
  path: { approval_id: 'apr_01' },
  body: { arguments: { amount: 450 } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/approvals/apr_01/approve \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"amount": 450}}'
```

</TabItem>
</Tabs>

### Reject with a reason

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat reject-approval --approval-id apr_01 --reason "Exceeds monthly budget"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.approvals.rejectApproval({
  path: { approval_id: 'apr_01' },
  body: { reason: 'Exceeds monthly budget' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/approvals/apr_01/reject \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Exceeds monthly budget"}'
```

</TabItem>
</Tabs>
