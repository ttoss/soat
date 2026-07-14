---
description: "Human-decision approval queue with frozen evidence and server-enforced expiry in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Approvals

A centralized queue of human decisions. When an agent proposes a risky action,
the platform files an **approval item** carrying the frozen proposed action, the
supporting evidence, and a hard expiry — then a human approves, edits-then-approves,
or rejects it.

## Overview

Approvals are a producer-agnostic platform module: anything that can propose a
risky action is a thin producer over the same queue. The queue — not any single
producer — is the product. One item model, one expiry enforcement path, one
decision output shape, so every consumer (activity feed, webhooks, UIs) treats an
item the same regardless of where it came from.

Items are **created by the platform only** — there is no public create endpoint.
The Phase 1 producer is the `approval` orchestration node; tool-call interception
follows in Phase 2. The `origin` field (`node` \| `tool_call`) records which
producer filed an item, for analytics and filtering only — the lifecycle never
branches on it.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Approval Gates - Step 7 (Approve it — the run resumes)](/docs/tutorials/approval-gate#step-7--approve-it--the-run-resumes)

## Data Model

| Field                | Type            | Description                                                        |
| -------------------- | --------------- | ------------------------------------------------------------------ |
| `id`                 | string          | Public identifier (`apr_…`)                                        |
| `project_id`         | string          | ID of the owning project                                           |
| `origin`             | string          | `node` \| `tool_call` — producer origin (analytics/filtering only) |
| `status`             | string          | `pending` \| `approved` \| `rejected` \| `expired`                 |
| `proposed_action`    | object          | Frozen `{ tool_id, arguments }` the decision governs               |
| `reasoning`          | string \| null  | The proposing agent's rationale                                    |
| `evidence`           | object \| null  | Structured supporting data                                         |
| `predicted_impact`   | string \| null  | Expected execution effect                                          |
| `expires_at`         | string          | Server-enforced hard gate; the item can never execute after this   |
| `dedup_key`          | string \| null  | Set on tool-call items to suppress duplicate proposals             |
| `run_id`             | string \| null  | Originating orchestration run (node producer)                      |
| `node_id`            | string \| null  | Originating node id within the run's graph                         |
| `generation_id`      | string \| null  | Originating generation (tool-call producer)                        |
| `agent_id`           | string \| null  | Proposing agent                                                    |
| `knowledge_version`  | string \| null  | Knowledge package version in context at emit time                  |
| `policy_version`     | string \| null  | Guardrail policy version that routed here                          |
| `resolved_by`        | string \| null  | Resolving user's public ID; `null` on expiry                       |
| `resolution_reason`  | string \| null  | Required on rejection                                              |
| `edited_arguments`   | object \| null  | Set on edit-then-approve; the original stays in `proposed_action`  |
| `created_at`         | string          | ISO 8601 creation timestamp                                        |
| `updated_at`         | string          | ISO 8601 last-updated timestamp                                    |

## Key Concepts

### Snapshot at emit time

All of an item's evidence (`proposed_action`, `reasoning`, `evidence`,
`predicted_impact`) is resolved against run/call state at emit time and **frozen**
onto the item. Later state changes never alter what the approver sees — a decision
is made on exactly the evidence the agent had.

### Expiry is a hard gate

Evidence goes stale, so expiry is enforced server-side in **both directions**:

- A background sweeper flips overdue `pending` items to `expired` and emits
  `approvals.expired`.
- The resolution path re-checks `expires_at` at decision time, closing the
  sweep-vs-approve race. An expired item can never be approved or executed — even
  a click a millisecond after expiry returns `409 APPROVAL_EXPIRED`.

### Approve, reject, edit-then-approve

- **Approve** resolves the item and resumes its producer with the decision — an
  `approval` orchestration node routes down its `approved` edge (where a
  downstream `tool` node acts on the frozen or edited arguments).
- **Edit-then-approve** replaces the arguments via the `arguments` field on the
  approve call. Edited arguments must be a JSON object; the original proposal is
  preserved in `proposed_action`, and the edit is recorded in `edited_arguments`.
- **Reject** requires a `reason`, preserved on the item. Rejection reasons and
  edit diffs are the raw material of the learned-rules feedback loop.

### Decision output

Resolution produces a producer-agnostic decision artifact — the `approval`
orchestration node consumes it as its node result; a tool-call continuation
consumes it as the tool result. Identical shape for both:

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
- `result` — the executed tool output on approval (populated by the producer that
  executes the approved action)

### Who may resolve

Any principal with `approvals:ResolveApproval` in the project may resolve any of
the project's items. There is no per-item targeting or assignment — the guardrail
policy decides *what* needs a human, and the project policy layer decides *who*
counts as one. Per-approver routing is a deferred future phase.

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
