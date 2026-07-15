---
description: "Use orchestration control-flow nodes — delay, poll, loop, and condition — to pace, wait, repeat, and branch a run."
sidebar_position: 13
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestration Control Flow: Delay, Poll, and Loop

This tutorial focuses on the **control-flow nodes** of the [Orchestrations](/docs/modules/orchestrations) module — the ones that pace, wait, repeat, and branch a run rather than call an LLM. You will build one orchestration that uses, in order, a `delay`, a `poll`, a `loop` (which runs a sub-orchestration per item), and a `condition` that routes to a terminal `transform`.

You will:

1. Create a project.
2. Create a small **sub-orchestration** that the loop runs once per item.
3. Create a [SOAT tool](/docs/modules/tools) the `poll` node calls each attempt.
4. Define the main [orchestration](/docs/modules/orchestrations) wiring `delay → poll → loop → condition → transform`.
5. Run it and inspect the per-node executions.

Everything here is deterministic — **no AI provider is required**. For `agent` nodes (LLM calls), see [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet); a [reference table](#every-node-type) at the end maps every node type to where it is demonstrated.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, tools, and runs first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- For production hardening (secrets, env vars), see [Configuration](/docs/self-hosting/configuration).
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
PROJECT_ID=$(soat create-project --name "Node Tour" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Node Tour' },
});
const PROJECT_ID = project.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Node Tour"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the per-item sub-orchestration

The `loop` node runs a whole [orchestration](/docs/modules/orchestrations#loops-collection-iteration) once per item in a collection. Create a tiny child orchestration that receives one `item` and echoes it through a `transform` node. The loop injects each element under the `item` variable, seeded into the sub-run's input namespace, so the child reads it with `{"var": "input.item"}`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SUB_ORCH_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Process One Item" \
  --nodes '[{"id":"echo","type":"transform","expression":{"var":"input.item"},"state_mapping":{"state.processed":{"var":"output.result"}}}]' \
  --edges '[]' | jq -r '.id')
echo "SUB_ORCH_ID: $SUB_ORCH_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: subOrch } = await adminSoat.orchestrations.createOrchestration({
  body: {
    project_id: PROJECT_ID,
    name: 'Process One Item',
    nodes: [
      {
        id: 'echo',
        type: 'transform',
        expression: { var: 'input.item' },
        state_mapping: { 'state.processed': { var: 'output.result' } },
      },
    ],
    edges: [],
  },
});
const SUB_ORCH_ID = subOrch.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SUB_ORCH_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestrations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Process One Item\",\"nodes\":[{\"id\":\"echo\",\"type\":\"transform\",\"expression\":{\"var\":\"input.item\"},\"state_mapping\":{\"state.processed\":{\"var\":\"output.result\"}}}],\"edges\":[]}" \
  | jq -r '.id')
echo "SUB_ORCH_ID: $SUB_ORCH_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create the tool the poll node calls

A `poll` node repeatedly calls a [Tool](/docs/modules/tools#examples) until a JSON Logic exit condition on its response holds. Create a [SOAT tool](/docs/modules/tools) that reads this project back via the `get-project` action. Polling a resource until a field reaches an expected value is the canonical use of a `poll` node — here the project is already readable, so the loop exits on the first attempt.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
CHECK_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "read-project" \
  --type "soat" \
  --description "Read this project so the poll node can check readiness" \
  --actions '["get-project"]' \
  --preset-parameters '{"projectId": "'"$PROJECT_ID"'"}' | jq -r '.id')
echo "CHECK_TOOL_ID: $CHECK_TOOL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: checkTool } = await adminSoat.tools.createTool({
  body: {
    project_id: PROJECT_ID,
    name: 'read-project',
    type: 'soat',
    description: 'Read this project so the poll node can check readiness',
    actions: ['get-project'],
    preset_parameters: { projectId: PROJECT_ID },
  },
});
const CHECK_TOOL_ID = checkTool.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
CHECK_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"read-project\",\"type\":\"soat\",\"description\":\"Read this project so the poll node can check readiness\",\"actions\":[\"get-project\"],\"preset_parameters\":{\"projectId\":\"$PROJECT_ID\"}}" \
  | jq -r '.id')
echo "CHECK_TOOL_ID: $CHECK_TOOL_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Create the control-flow orchestration

This [orchestration](/docs/modules/orchestrations#node-types) chains the control-flow nodes:

- **`delay`** — waits a fixed `duration`. Accepts the friendly suffix form (`1s`, `5m`, `2h`) or ISO 8601 (`PT1S`).
- **`poll`** — calls the tool each attempt and stops when `exit_condition` is truthy, bounded by `interval` + `max_iterations`. The condition is evaluated against the run state plus `response` (the latest tool result) and `attempt`. See [Polling](/docs/modules/orchestrations#polling).
- **`loop`** — runs `orchestration_id` once per element of `collection`, injecting each as `item_variable`. This is the *same* `orchestration_id` field the standalone `sub_orchestration` node uses. See [Loops](/docs/modules/orchestrations#loops-collection-iteration).
- **`condition`** — emits a label; outgoing edges select a branch with `condition: "<label>"`.
- **`transform`** — the terminal node on each branch.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ORCH_NODES='[
  {"id":"pace","type":"delay","duration":"1s"},
  {"id":"wait-ready","type":"poll","tool_id":"'"$CHECK_TOOL_ID"'","operation_id":"get-project","exit_condition":{"==":[{"var":"response.id"},"'"$PROJECT_ID"'"]},"interval":"1s","max_iterations":5,"state_mapping":{"state.project":{"var":"output.result"}}},
  {"id":"process-each","type":"loop","orchestration_id":"'"$SUB_ORCH_ID"'","collection":"state.input.items","item_variable":"item","state_mapping":{"state.results":{"var":"output.results"}}},
  {"id":"route","type":"condition","expression":{"if":[{"var":"results"},"processed","none"]}},
  {"id":"summary-processed","type":"transform","expression":"Items were processed.","state_mapping":{"state.summary":{"var":"output.result"}}},
  {"id":"summary-none","type":"transform","expression":"No items to process.","state_mapping":{"state.summary":{"var":"output.result"}}}
]'

ORCH_EDGES='[
  {"from":"pace","to":"wait-ready"},
  {"from":"wait-ready","to":"process-each"},
  {"from":"process-each","to":"route"},
  {"from":"route","to":"summary-processed","condition":"processed"},
  {"from":"route","to":"summary-none","condition":"none"}
]'

ORCHESTRATION_ID=$(soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "Control Flow Tour" \
  --description "delay, poll, loop, condition" \
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
      name: 'Control Flow Tour',
      description: 'delay, poll, loop, condition',
      nodes: [
        { id: 'pace', type: 'delay', duration: '1s' },
        {
          id: 'wait-ready',
          type: 'poll',
          tool_id: CHECK_TOOL_ID,
          operation_id: 'get-project',
          exit_condition: { '==': [{ var: 'response.id' }, PROJECT_ID] },
          interval: '1s',
          max_iterations: 5,
          state_mapping: { 'state.project': { var: 'output.result' } },
        },
        {
          id: 'process-each',
          type: 'loop',
          orchestration_id: SUB_ORCH_ID,
          collection: 'state.input.items',
          item_variable: 'item',
          state_mapping: { 'state.results': { var: 'output.results' } },
        },
        {
          id: 'route',
          type: 'condition',
          expression: { if: [{ var: 'results' }, 'processed', 'none'] },
        },
        {
          id: 'summary-processed',
          type: 'transform',
          expression: 'Items were processed.',
          state_mapping: { 'state.summary': { var: 'output.result' } },
        },
        {
          id: 'summary-none',
          type: 'transform',
          expression: 'No items to process.',
          state_mapping: { 'state.summary': { var: 'output.result' } },
        },
      ],
      edges: [
        { from: 'pace', to: 'wait-ready' },
        { from: 'wait-ready', to: 'process-each' },
        { from: 'process-each', to: 'route' },
        { from: 'route', to: 'summary-processed', condition: 'processed' },
        { from: 'route', to: 'summary-none', condition: 'none' },
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
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Control Flow Tour\",\"description\":\"delay, poll, loop, condition\",\"nodes\":[{\"id\":\"pace\",\"type\":\"delay\",\"duration\":\"1s\"},{\"id\":\"wait-ready\",\"type\":\"poll\",\"tool_id\":\"$CHECK_TOOL_ID\",\"operation_id\":\"get-project\",\"exit_condition\":{\"==\":[{\"var\":\"response.id\"},\"$PROJECT_ID\"]},\"interval\":\"1s\",\"max_iterations\":5,\"state_mapping\":{\"state.project\":{\"var\":\"output.result\"}}},{\"id\":\"process-each\",\"type\":\"loop\",\"orchestration_id\":\"$SUB_ORCH_ID\",\"collection\":\"state.input.items\",\"item_variable\":\"item\",\"state_mapping\":{\"state.results\":{\"var\":\"output.results\"}}},{\"id\":\"route\",\"type\":\"condition\",\"expression\":{\"if\":[{\"var\":\"results\"},\"processed\",\"none\"]}},{\"id\":\"summary-processed\",\"type\":\"transform\",\"expression\":\"Items were processed.\",\"state_mapping\":{\"state.summary\":{\"var\":\"output.result\"}}},{\"id\":\"summary-none\",\"type\":\"transform\",\"expression\":\"No items to process.\",\"state_mapping\":{\"state.summary\":{\"var\":\"output.result\"}}}],\"edges\":[{\"from\":\"pace\",\"to\":\"wait-ready\"},{\"from\":\"wait-ready\",\"to\":\"process-each\"},{\"from\":\"process-each\",\"to\":\"route\"},{\"from\":\"route\",\"to\":\"summary-processed\",\"condition\":\"processed\"},{\"from\":\"route\",\"to\":\"summary-none\",\"condition\":\"none\"}]}" \
  | jq -r '.id')
echo "ORCHESTRATION_ID: $ORCHESTRATION_ID"
```

</TabItem>
</Tabs>

---

## Step 6 — Run it

Start a [run](/docs/modules/orchestrations#examples) with a list of items. The `loop` processes each through the sub-orchestration, and the `condition` routes to `summary-processed` because the results are non-empty.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RUN=$(soat start-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --input '{"items":["alpha","beta","gamma"]}')

printf '%s\n' "$RUN" | jq '{status, output}'
RUN_ID=$(printf '%s\n' "$RUN" | jq -r '.id')
echo "RUN_ID: $RUN_ID"
```

Expected output:

```json
{
  "status": "succeeded",
  "output": {
    "summary-processed": {
      "result": "Items were processed."
    }
  }
}
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: run } = await adminSoat.orchestrations.startOrchestrationRun({
  body: {
    orchestration_id: ORCHESTRATION_ID,
    input: { items: ['alpha', 'beta', 'gamma'] },
  },
});

console.log('Status:', run.status);
console.log('Output:', run.output);
const RUN_ID = run.id;
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RUN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/orchestration-runs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\":\"$ORCHESTRATION_ID\",\"input\":{\"items\":[\"alpha\",\"beta\",\"gamma\"]}}")

printf '%s\n' "$RUN" | jq '{status, output}'
RUN_ID=$(printf '%s\n' "$RUN" | jq -r '.id')
echo "RUN_ID: $RUN_ID"
```

</TabItem>
</Tabs>

---

## Step 7 — Inspect the per-node executions

`get-orchestration-run` returns the run [state](/docs/modules/orchestrations#state-and-mappings) and one record per executed node. Note that `summary-none` shows `skipped` — the `condition` routed away from it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-orchestration-run \
  --orchestration-id "$ORCHESTRATION_ID" \
  --run-id "$RUN_ID" | jq '{status, state: {results: .state.results, summary: .state.summary}, nodes: [.node_executions[] | {node_id, node_type, status}]}'
```

Look for:

- `state.results` — one entry per item, each the sub-orchestration's output.
- `state.summary` — `"Items were processed."` (written by the branch the `condition` selected).
- `node_executions` — `wait-ready` completed after one attempt; `summary-none` is `skipped`.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: runState } = await adminSoat.orchestrations.getOrchestrationRun({
  path: { run_id: RUN_ID },
});
console.log('results:', runState.state.results);
console.log('summary:', runState.state.summary);
console.log(
  'nodes:',
  runState.node_executions?.map((n) => ({
    node_id: n.node_id,
    node_type: n.node_type,
    status: n.status,
  }))
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/orchestration-runs/$RUN_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{status, results: .state.results, summary: .state.summary, nodes: [.node_executions[] | {node_id, node_type, status}]}'
```

</TabItem>
</Tabs>

---

## How It Works

- **`delay`** holds the run for its `duration` before activating the next node. It runs inside the synchronous run loop, so keep durations short and bounded.
- **`poll`** calls its tool, evaluates `exit_condition` against `{ ...state, response, attempt }`, and either stops (truthy) or waits `interval` and retries — up to `max_iterations`. On exhaustion it completes with `condition_met: false` unless `fail_on_timeout: true`. Each polled call should be safe to repeat.
- **`loop`** fans out over `collection`, running `orchestration_id` once per item with the element bound to `item_variable`, and collects each sub-run's output into `{ results: [...] }`.
- **`condition`** turns a JSON Logic result into a string label; edges pick the matching branch with `condition`. Unselected branches are recorded as `skipped`.
- **`transform`** computes a value (or, as here, returns a literal) and writes it to state via `state_mapping`.

To see the `none` branch, run again with `--input '{"items":[]}'`: the empty collection makes `loop` produce `[]`, the `condition` evaluates to `none`, and `summary-none` runs instead.

## Every node type

This tutorial exercises the control-flow nodes. The full set of [node types](/docs/modules/orchestrations#node-types):

| Node | Where to see it |
| --- | --- |
| `delay` | This tutorial — Step 5 |
| `poll` | This tutorial — Step 5 ([Polling](/docs/modules/orchestrations#polling)) |
| `loop` | This tutorial — Step 5 ([Loops](/docs/modules/orchestrations#loops-collection-iteration)) |
| `condition` | This tutorial; [Conditional Branching](/docs/tutorials/conditional-orchestration) |
| `transform` | This tutorial; [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) |
| `tool` | This tutorial (the poll's SOAT tool); [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet) |
| `sub_orchestration` | Same `orchestration_id` field the `loop` uses here — runs a child orchestration as a single step |
| `agent` | [Orchestrate a Sonnet](/docs/tutorials/orchestrate-a-sonnet), [Multi-Agent Orchestration](/docs/tutorials/multi-agent-orchestration) |
| `knowledge` | [Knowledge](/docs/modules/knowledge) — searches a knowledge source into state |
| `memory_write` | [Memories](/docs/modules/memories) — writes a memory entry |
| `human` | [Orchestrations — Node Types](/docs/modules/orchestrations#node-types) — pauses the run for external input |
| `webhook` | [Orchestrations — Node Types](/docs/modules/orchestrations#node-types) — emits or awaits an HTTP callback |
