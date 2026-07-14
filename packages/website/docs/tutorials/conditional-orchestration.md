---
description: "Build a branching orchestration with condition nodes and see skipped nodes recorded in the execution trace."
sidebar_position: 12
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Conditional Branching in Orchestrations

This tutorial shows how to build a branching orchestration using [condition nodes](/docs/modules/orchestrations#node-types). When a run completes, every node that was not reached is recorded with `status: "skipped"` — giving you a complete execution trace regardless of which path ran.

You will:

1. Create a project.
2. Define an orchestration with a `condition` node that routes to one of two `transform` branches based on run input.
3. Start two runs — one for each branch — and inspect the `node_executions` to confirm which nodes ran and which were skipped.

No AI provider is required — this tutorial uses only `condition` and `transform` nodes.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to orchestrations? Read [Key Concepts](/docs/getting-started/concepts) and the [Orchestrations module](/docs/modules/orchestrations) before diving in.
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

See [Users](/docs/modules/users#examples) for authentication details.

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
  token: login!.token,
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

All orchestrations belong to a [project](/docs/modules/projects).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "triage-demo" | jq -r '.id')
echo "Project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'triage-demo' },
});
const PROJECT_ID = project!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"triage-demo"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Create the orchestration

The graph has three nodes:

| Node | Type | Purpose |
|---|---|---|
| `route` | `condition` | Evaluates `urgent` from input state and emits `"alert"` or `"queue"` |
| `send_alert` | `transform` | Runs only on the `alert` branch |
| `queue_task` | `transform` | Runs only on the `queue` branch |

Edges carry `condition: "<label>"` to select which branch the engine traverses after `route` completes. A node whose only incoming edge is not traversed is recorded as `skipped` when the run finishes. See [Orchestrations — Node Types](/docs/modules/orchestrations#node-types) for the full condition node reference.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "content-triage" \
  --nodes '[
    {
      "id": "route",
      "type": "condition",
      "expression": {"if": [{"var": "input.urgent"}, "alert", "queue"]}
    },
    {
      "id": "send_alert",
      "type": "transform",
      "expression": {"cat": ["ALERT: ", {"var": "input.topic"}]},
      "state_mapping":{"state.result":{"var":"output.result"}}
    },
    {
      "id": "queue_task",
      "type": "transform",
      "expression": {"cat": ["QUEUED: ", {"var": "input.topic"}]},
      "state_mapping":{"state.result":{"var":"output.result"}}
    }
  ]' \
  --edges '[
    {"from": "route", "to": "send_alert", "condition": "alert"},
    {"from": "route", "to": "queue_task", "condition": "queue"}
  ]' | jq -r '.id')
echo "Orchestration: $ORCH_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: orch } = await adminSoat.orchestrations.createOrchestration({
  body: {
    project_id: PROJECT_ID,
    name: 'content-triage',
    nodes: [
      {
        id: 'route',
        type: 'condition',
        expression: { if: [{ var: 'input.urgent' }, 'alert', 'queue'] },
      },
      {
        id: 'send_alert',
        type: 'transform',
        expression: { cat: ['ALERT: ', { var: 'input.topic' }] },
        state_mapping: { 'state.result': { var: 'output.result' } },
      },
      {
        id: 'queue_task',
        type: 'transform',
        expression: { cat: ['QUEUED: ', { var: 'input.topic' }] },
        state_mapping: { 'state.result': { var: 'output.result' } },
      },
    ],
    edges: [
      { from: 'route', to: 'send_alert', condition: 'alert' },
      { from: 'route', to: 'queue_task', condition: 'queue' },
    ],
  },
});
const ORCH_ID = orch!.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ORCH_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "content-triage",
    "nodes": [
      {"id":"route","type":"condition","expression":{"if":[{"var":"input.urgent"},"alert","queue"]}},
      {"id":"send_alert","type":"transform","expression":{"cat":["ALERT: ",{"var":"input.topic"}]},"state_mapping":{"state.result":{"var":"output.result"}}},
      {"id":"queue_task","type":"transform","expression":{"cat":["QUEUED: ",{"var":"input.topic"}]},"state_mapping":{"state.result":{"var":"output.result"}}}
    ],
    "edges": [
      {"from":"route","to":"send_alert","condition":"alert"},
      {"from":"route","to":"queue_task","condition":"queue"}
    ]
  }' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 4 — Run the alert branch

Pass `urgent: true`. The engine evaluates the `route` condition, emits `"alert"`, traverses only the `send_alert` edge, and records `queue_task` as `skipped`. See [Orchestrations — Node Executions](/docs/modules/orchestrations#node-executions) for the full execution trace schema.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ALERT_RUN=$(soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --input '{"urgent": true, "topic": "Server is down"}')

echo "$ALERT_RUN" | jq '{status, result: .output, executions: .node_executions | map({node_id, status})}'
```

Expected output:

```json
{
  "status": "succeeded",
  "result": null,
  "executions": [
    { "node_id": "route",      "status": "completed" },
    { "node_id": "send_alert", "status": "completed" },
    { "node_id": "queue_task", "status": "skipped"   }
  ]
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: alertRun } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCH_ID,
    input: { urgent: true, topic: 'Server is down' },
  },
});

// send_alert ran; queue_task was skipped
console.log(alertRun!.node_executions?.map(e => ({ id: e.node_id, status: e.status })));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id":"'"$ORCH_ID"'","input":{"urgent":true,"topic":"Server is down"}}' \
  | jq '.node_executions | map({node_id, status})'
```

</TabItem>
</Tabs>

The `queue_task` node appears in the trace with `status: "skipped"`, `output: null`, and `started_at: null` — confirming it was never executed.

---

## Step 5 — Run the queue branch

Pass `urgent: false`. Now `route` emits `"queue"`, `send_alert` is skipped, and `queue_task` runs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
QUEUE_RUN=$(soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --input '{"urgent": false, "topic": "Update documentation"}')

echo "$QUEUE_RUN" | jq '.node_executions | map({node_id, status})'
```

Expected output:

```json
[
  { "node_id": "route",      "status": "completed" },
  { "node_id": "send_alert", "status": "skipped"   },
  { "node_id": "queue_task", "status": "completed"  }
]
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: queueRun } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCH_ID,
    input: { urgent: false, topic: 'Update documentation' },
  },
});

console.log(queueRun!.node_executions?.map(e => ({ id: e.node_id, status: e.status })));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id":"'"$ORCH_ID"'","input":{"urgent":false,"topic":"Update documentation"}}' \
  | jq '.node_executions | map({node_id, status})'
```

</TabItem>
</Tabs>

---

## What you built

A branching orchestration where a single `condition` node decides which downstream path executes:

```
input
  └─▶ route (condition)
        ├─▶ send_alert  (condition: "alert")  ← runs when urgent = true
        └─▶ queue_task  (condition: "queue")  ← runs when urgent = false
```

Key takeaways:

- A `condition` node evaluates a [JSON Logic](https://jsonlogic.com) expression and emits a string label. Downstream edges carry `condition: "<label>"` to match that label.
- Nodes whose incoming edges are never traversed are recorded as `skipped` once the run completes — every declared node is always visible in the `node_executions` trace.
- The branching logic lives in the graph definition, not inside each individual node. Nodes stay single-responsibility.

To apply this pattern to a real pipeline, replace the `transform` nodes with `agent` nodes pointing at specialized agents for each branch. See [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) and [Multi-Agent Orchestration](/docs/tutorials/multi-agent-orchestration) for examples that wire agents into an orchestration graph.
