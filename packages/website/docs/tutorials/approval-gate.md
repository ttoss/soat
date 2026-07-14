---
description: "Pause an orchestration for a human decision with an approval node, then approve or reject it from the approvals queue."
sidebar_position: 18
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Approval Gates: Human-in-the-Loop with the `approval` Node

An [`approval` node](/docs/modules/orchestrations#approval-nodes) pauses an orchestration run and files a human-decision item in the [Approvals](/docs/modules/approvals) queue. A person then **approves**, **rejects**, or lets it **expire**, and the run resumes down the matching decision edge. This is the manage-by-exception pattern: the agent proposes a risky action, a human decides, and the run continues automatically.

You will:

1. Create a project.
2. Create the [SOAT tool](/docs/modules/tools) whose call the approval gates.
3. Define an [orchestration](/docs/modules/orchestrations) whose `approval` node branches to `approved` / `rejected` / `expired` edges.
4. Start a run and watch it pause with a pending approval item.
5. Approve one run and reject another, and see each resume down the right branch.

Everything here is deterministic — **no AI provider is required**.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, tools, and runs first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/getting-started/advanced-config).
- Server is at `http://localhost:5047`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. See [Users](/docs/modules/users#examples) for authentication details.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 2 — Create a project

Every resource lives inside a [project](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Approvals Demo" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Approvals Demo' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Approvals Demo"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the tool the approval gates

The `approval` node names the [Tool](/docs/modules/tools#examples) whose call is under review and freezes the proposed arguments onto the item — it records the proposal, it does not run the tool (a downstream node performs the action once approved). Create a read-only [SOAT tool](/docs/modules/tools) so the tutorial needs no external services; in a real system this would be your refund, payment, or deployment tool.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
REFUND_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "issue-refund" \
  --type "soat" \
  --description "Stand-in for the sensitive action the approval gates" \
  --actions '["get-project"]' \
  --preset-parameters '{"projectId": "'"$PROJECT_ID"'"}' | jq -r '.id')
echo "REFUND_TOOL_ID: $REFUND_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: refundTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'issue-refund',
    type: 'soat',
    description: 'Stand-in for the sensitive action the approval gates',
    actions: ['get-project'],
    preset_parameters: { projectId: PROJECT_ID },
  },
});
const REFUND_TOOL_ID = refundTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
REFUND_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"issue-refund\",\"type\":\"soat\",\"description\":\"Stand-in for the sensitive action the approval gates\",\"actions\":[\"get-project\"],\"preset_parameters\":{\"projectId\":\"$PROJECT_ID\"}}" \
  | jq -r '.id')
echo "REFUND_TOOL_ID: $REFUND_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create the orchestration with an approval gate

The [`approval` node](/docs/modules/orchestrations#approval-nodes) resolves its `arguments` against run state, freezes them onto an approval item, and pauses the run. On resolution the decision becomes the node's branch label: edges labeled `condition: "approved"` / `"rejected"` / `"expired"` route accordingly (an unlabeled edge would follow only on approval). Here each branch ends in a `transform` that records the outcome.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_NODES='[
  {"id":"gate","type":"approval","tool_id":"'"$REFUND_TOOL_ID"'","arguments":{"amount":{"var":"input.amount"}},"reasoning":"Refund exceeds the auto-approve threshold.","expires_in":3600,"instructions":"Approve or reject this refund."},
  {"id":"issue","type":"transform","expression":"Refund issued.","state_mapping":{"state.outcome":{"var":"output.result"}}},
  {"id":"declined","type":"transform","expression":"Refund declined.","state_mapping":{"state.outcome":{"var":"output.result"}}},
  {"id":"stale","type":"transform","expression":"Approval expired.","state_mapping":{"state.outcome":{"var":"output.result"}}}
]'

ORCH_EDGES='[
  {"from":"gate","to":"issue","condition":"approved"},
  {"from":"gate","to":"declined","condition":"rejected"},
  {"from":"gate","to":"stale","condition":"expired"}
]'

ORCHESTRATION_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Refund Approval Gate" \
  --description "Human approves or rejects a refund" \
  --nodes "$ORCH_NODES" \
  --edges "$ORCH_EDGES" | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orchestration } =
  await adminSoat.orchestrations.createOrchestration({
    body: {
      project_id: PROJECT_ID,
      name: 'Refund Approval Gate',
      description: 'Human approves or rejects a refund',
      nodes: [
        {
          id: 'gate',
          type: 'approval',
          tool_id: REFUND_TOOL_ID,
          arguments: { amount: { var: 'input.amount' } },
          reasoning: 'Refund exceeds the auto-approve threshold.',
          expires_in: 3600,
          instructions: 'Approve or reject this refund.',
        },
        {
          id: 'issue',
          type: 'transform',
          expression: 'Refund issued.',
          state_mapping: { 'state.outcome': { var: 'output.result' } },
        },
        {
          id: 'declined',
          type: 'transform',
          expression: 'Refund declined.',
          state_mapping: { 'state.outcome': { var: 'output.result' } },
        },
        {
          id: 'stale',
          type: 'transform',
          expression: 'Approval expired.',
          state_mapping: { 'state.outcome': { var: 'output.result' } },
        },
      ],
      edges: [
        { from: 'gate', to: 'issue', condition: 'approved' },
        { from: 'gate', to: 'declined', condition: 'rejected' },
        { from: 'gate', to: 'stale', condition: 'expired' },
      ],
    },
  });
const ORCHESTRATION_ID = orchestration.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCHESTRATION_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Refund Approval Gate\",\"description\":\"Human approves or rejects a refund\",\"nodes\":[{\"id\":\"gate\",\"type\":\"approval\",\"tool_id\":\"$REFUND_TOOL_ID\",\"arguments\":{\"amount\":{\"var\":\"input.amount\"}},\"reasoning\":\"Refund exceeds the auto-approve threshold.\",\"expires_in\":3600,\"instructions\":\"Approve or reject this refund.\"},{\"id\":\"issue\",\"type\":\"transform\",\"expression\":\"Refund issued.\",\"state_mapping\":{\"state.outcome\":{\"var\":\"output.result\"}}},{\"id\":\"declined\",\"type\":\"transform\",\"expression\":\"Refund declined.\",\"state_mapping\":{\"state.outcome\":{\"var\":\"output.result\"}}},{\"id\":\"stale\",\"type\":\"transform\",\"expression\":\"Approval expired.\",\"state_mapping\":{\"state.outcome\":{\"var\":\"output.result\"}}}],\"edges\":[{\"from\":\"gate\",\"to\":\"issue\",\"condition\":\"approved\"},{\"from\":\"gate\",\"to\":\"declined\",\"condition\":\"rejected\"},{\"from\":\"gate\",\"to\":\"stale\",\"condition\":\"expired\"}]}" \
  | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Start a run — it pauses for approval

Start a [run](/docs/modules/orchestrations#examples). The `approval` node pauses it as `awaiting_input` and the response's `required_action` carries the created approval item's `approval_id` and `expires_at`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN=$(soat start-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"amount":500}')

printf '%s\n' "$RUN" | jq '{status, required_action}'
RUN_ID=$(printf '%s\n' "$RUN" | jq -r '.id')
APPROVAL_ID=$(printf '%s\n' "$RUN" | jq -r '.required_action.approval_id')
echo "RUN_ID: $RUN_ID"
echo "APPROVAL_ID: $APPROVAL_ID"
```

Expected output:

```json
{
  "status": "awaiting_input",
  "required_action": {
    "type": "approval",
    "node_id": "gate",
    "approval_id": "apr_...",
    "expires_at": "..."
  }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await adminSoat.orchestrations.startOrchestrationRun({
  body: { orchestration_id: ORCHESTRATION_ID, input: { amount: 500 } },
});

console.log('Status:', run.status);
console.log('Required action:', run.required_action);
const RUN_ID = run.id;
const APPROVAL_ID = run.required_action.approval_id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"amount\":500}}")

printf '%s\n' "$RUN" | jq '{status, required_action}'
RUN_ID=$(printf '%s\n' "$RUN" | jq -r '.id')
APPROVAL_ID=$(printf '%s\n' "$RUN" | jq -r '.required_action.approval_id')
echo "RUN_ID: $RUN_ID"
echo "APPROVAL_ID: $APPROVAL_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — See the pending item in the queue

The item is now in the [Approvals](/docs/modules/approvals#data-model) queue with the frozen proposed action and its provenance (the originating run and node). Anyone with `approvals:ResolveApproval` on the project can act on it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-approvals --project-id "$PROJECT_ID" --status pending \
  | jq '.[] | {id, status, origin, run_id, node_id, proposed_action}'
```

Look for `origin: "node"`, `run_id` matching your run, and `proposed_action.arguments` equal to `{ "amount": 500 }`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: pending } = await adminSoat.approvals.listApprovals({
  query: { project_id: PROJECT_ID, status: 'pending' },
});
console.log(pending);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/approvals?project_id=$PROJECT_ID&status=pending" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.[] | {id, status, origin, run_id, node_id, proposed_action}'
```

</TabItem>
</Tabs>

---

## Step 7 — Approve it — the run resumes

Approving resolves the [item](/docs/modules/approvals#approve-reject-edit-then-approve) and resumes the parked run down the `approved` edge, which runs the `issue` node. To approve with different arguments (edit-then-approve), pass `--arguments '{"amount": 450}'`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat approve-approval --approval-id "$APPROVAL_ID" | jq '{status, resolved_by}'

soat get-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --run-id "$RUN_ID" | jq '{status, outcome: .state.outcome}'
```

Expected output:

```json
{
  "status": "succeeded",
  "outcome": "Refund issued."
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await adminSoat.approvals.approveApproval({
  path: { approval_id: APPROVAL_ID },
  body: {},
});

const { data: resumed } = await adminSoat.orchestrations.getOrchestrationRun({
  path: { run_id: RUN_ID },
});
console.log('Status:', resumed.status);
console.log('Outcome:', resumed.state.outcome);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/approvals/$APPROVAL_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '{status, resolved_by}'

curl -s "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{status, outcome: .state.outcome}'
```

</TabItem>
</Tabs>

---

## Step 8 — Reject a second run

Start another run and **reject** it. A reason is required, and the run resumes down the `rejected` edge to the `declined` node. Rejection reasons and edit diffs are the raw material of the learned-rules feedback loop described in the [Approvals](/docs/modules/approvals#approve-reject-edit-then-approve) module.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN2=$(soat start-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"amount":999}')
RUN2_ID=$(printf '%s\n' "$RUN2" | jq -r '.id')
APPROVAL2_ID=$(printf '%s\n' "$RUN2" | jq -r '.required_action.approval_id')

soat reject-approval --approval-id "$APPROVAL2_ID" --reason "Exceeds monthly budget." \
  | jq '{status, resolution_reason}'

soat get-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --run-id "$RUN2_ID" | jq '{status, outcome: .state.outcome}'
```

Expected output:

```json
{
  "status": "succeeded",
  "outcome": "Refund declined."
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run2 } = await adminSoat.orchestrations.startOrchestrationRun({
  body: { orchestration_id: ORCHESTRATION_ID, input: { amount: 999 } },
});

await adminSoat.approvals.rejectApproval({
  path: { approval_id: run2.required_action.approval_id },
  body: { reason: 'Exceeds monthly budget.' },
});

const { data: rejected } = await adminSoat.orchestrations.getOrchestrationRun({
  path: { run_id: run2.id },
});
console.log('Status:', rejected.status);
console.log('Outcome:', rejected.state.outcome);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN2=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"amount\":999}}")
RUN2_ID=$(printf '%s\n' "$RUN2" | jq -r '.id')
APPROVAL2_ID=$(printf '%s\n' "$RUN2" | jq -r '.required_action.approval_id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/approvals/$APPROVAL2_ID/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Exceeds monthly budget."}' | jq '{status, resolution_reason}'

curl -s "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN2_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{status, outcome: .state.outcome}'
```

</TabItem>
</Tabs>

---

## How It Works

- **Snapshot at emit time.** The node's `arguments`, `reasoning`, `evidence`, and `predicted_impact` are resolved against run state and frozen onto the [approval item](/docs/modules/approvals#snapshot-at-emit-time) when the run pauses. Later state changes never alter what the approver sees.
- **Decision routing.** The decision (`approved` / `rejected` / `expired`) becomes the paused node's branch label. Labeled edges select the branch, exactly like a [`condition` node](/docs/modules/orchestrations#node-types). An unlabeled edge from an approval node follows **only on approval**, so the rejection and expiry paths must be modeled with explicit labeled edges.
- **Expiry is a hard gate.** `expires_in` sets how long the item stays actionable. A background sweeper flips overdue items to `expired` and resumes the run down its `expired` edge; the resolution path re-checks expiry too, so a stale proposal can never execute. See [Expiry is a hard gate](/docs/modules/approvals#expiry-is-a-hard-gate).
- **Producer-agnostic queue.** The same queue, endpoints, and events serve any producer. Every item carries an `origin` (`node` here) so consumers never branch on where it came from.

## Next Steps

- Browse the whole queue and filter by status or origin — see [Approvals](/docs/modules/approvals#examples).
- Combine an approval gate with other control-flow nodes in [Orchestration Control Flow](/docs/tutorials/orchestration-control-flow).
- Route a decision through more branches with [Conditional Branching](/docs/tutorials/conditional-orchestration).
