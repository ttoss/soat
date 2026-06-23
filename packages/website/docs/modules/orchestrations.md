import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestrations

DAG-based workflow definitions for chaining agents, tools, and knowledge lookups into repeatable pipelines.

## Overview

Orchestrations let you describe a directed acyclic graph (DAG) of nodes where each node performs a discrete operation. Nodes in the same execution round run in parallel; edges with activation groups control fan-in convergence.

Use orchestrations when you know the exact steps in advance and want deterministic, auditable execution — not when you need an LLM to decide which steps to take. An agent node inside an orchestration can still use LLM reasoning internally, but the orchestration graph itself is deterministic.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph)
- [Orchestrate a Sonnet - Step 7 (Start a run)](/docs/tutorials/orchestrate-a-sonnet#step-7--start-a-run)
- [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state)

## Data Model

### Orchestration

| Field          | Type           | Description                                      |
| -------------- | -------------- | ------------------------------------------------ |
| `id`           | string         | Public ID (`orch_` prefix)                       |
| `project_id`   | string         | Owning project                                   |
| `name`         | string         | Human-readable name                              |
| `description`  | string \| null | Optional description                             |
| `nodes`        | array          | Ordered list of node definitions                 |
| `edges`        | array          | Directed connections between nodes               |
| `state_schema` | object         | Optional JSON Schema describing the run state    |
| `input_schema` | object         | Optional JSON Schema describing the run input    |
| `created_at`   | string         | ISO 8601 creation timestamp                      |
| `updated_at`   | string         | ISO 8601 last-updated timestamp                  |

### OrchestrationRun

| Field              | Type           | Description                                                     |
| ------------------ | -------------- | --------------------------------------------------------------- |
| `id`               | string         | Public ID (`run_` prefix)                                       |
| `orchestration_id` | string         | Parent orchestration                                            |
| `status`           | string         | `running` \| `paused` \| `completed` \| `failed` \| `cancelled` |
| `state`            | object         | Current mutable execution state                                 |
| `active_nodes`     | array          | Node IDs awaiting input (populated when status is `paused`)     |
| `artifacts`        | object         | Outputs keyed by node ID                                        |
| `error`            | object \| null | Error details if failed                                         |
| `current_node_id`  | string \| null | Most recently executed node ID                                  |
| `required_action`  | object \| null | Present when status is `paused` (see [Human Nodes](#human-nodes)) |
| `created_at`       | string         | ISO 8601 creation timestamp                                     |
| `updated_at`       | string         | ISO 8601 last-updated timestamp                                 |

## Key Concepts

### Node Types

| Type           | Description                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent`        | Invokes a SOAT [Agent](./agents.md) with a prompt. Uses `agentId` and `prompt`.                                                    |
| `tool`         | Calls a SOAT [Tool](./tools.md). Uses `toolId` and `inputMapping`.                                                                 |
| `transform`    | Evaluates a [JSON Logic](https://jsonlogic.com) rule against the current state. Uses `expression`.                                  |
| `knowledge`    | Searches a knowledge source via the [Knowledge](./knowledge.md) module. Uses `inputMapping` with `query` and optional `memoryIds`. |
| `memory_write` | Writes a [Memory](./memories.md) entry. Uses `memoryId` and `inputMapping` with `content`.                                        |
| `condition`    | Evaluates a JSON Logic rule and emits a string label. Downstream edges use `condition: "<label>"` to select the active branch.      |
| `human`        | Pauses the run and waits for external input. The run enters `paused` status with `requiredAction`.                                  |

### State and Mappings

Each node can define:

- **`inputMapping`** — Maps node input keys to values resolved against the run state before execution. Each value is [JSON Logic](https://jsonlogic.com) (see [Input Mapping](#input-mapping-json-logic)).
- **`outputMapping`** — Maps node outputs back to state paths after execution.

The root state is available to every node. Transforms and conditions receive the full state object.

#### Input Mapping (JSON Logic)

Each `inputMapping` value is evaluated as [JSON Logic](https://jsonlogic.com) against the run state — the same evaluator used by `transform` and `condition` nodes. This gives one expression language across the whole platform: pass literals, read state, or compute derived values inline, without a dedicated `transform` node.

| Value | Behaviour |
| ----- | --------- |
| String, number, boolean, array, multi-key object | Passed through as a literal |
| `{"var": "key"}` | Resolved from state — `state.key` (a missing key yields `null`) |
| Any other single-key JSON Logic object | Evaluated against state (`cat`, `>`, `if`, arithmetic, …) |

```json
"input_mapping": {
  "language": "pt-BR",
  "threshold": 0.8,
  "documentId": { "var": "temaDocumentId" },
  "label": { "cat": ["Tema: ", { "var": "titulo" }] },
  "isLong": { ">": [{ "var": "wordCount" }, 500] }
}
```

Values passed to [`start-orchestration-run`](#examples) via `input` become the initial state, so a node can reference them directly with `{"var": "key"}`.

> **Breaking change:** `inputMapping` values are no longer `state.<key>` path strings. A bare string is now a literal; use `{"var": "key"}` to read from state.

### Parallel Execution

All nodes that become active in the same round execute concurrently via `Promise.all`. After all complete, their outputs and state mutations are applied sequentially to avoid races. A single node with multiple outgoing edges activates all targets in parallel.

### Activation Groups (Fan-In)

Edges can carry an `activation_group` name and an `activation_condition` to control when a downstream node runs:

| `activation_condition` | Behaviour                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default)        | The target node activates only after **every** edge in the group comes from a completed node.                                     |
| `any`                  | The target node activates as soon as **any** edge in the group comes from a completed node. Activated at most once per run.       |

Edges without an `activation_group` always pass through unconditionally.

### Cycle Detection

Before execution begins, the engine performs a DFS-based cycle check. If a cycle is detected the run is created, set to `failed`, and the `error` field contains `code: "ORCHESTRATION_CYCLE_DETECTED"`.

### Human Nodes

When a `human` node is reached, the run pauses and the GET run response includes a `required_action` object:

```json
{
  "required_action": {
    "type": "human_input",
    "node_id": "approval",
    "prompt": "Please approve or reject."
  }
}
```

## Examples

### Create a sequential pipeline

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "fetch-and-summarize" \
  --nodes '[
    {"id":"fetch","type":"tool","tool_id":"tool_abc","output_mapping":{"result":"state.raw"}},
    {"id":"summarise","type":"agent","agent_id":"agt_xyz","input_mapping":{"prompt":{"var":"raw"}},"output_mapping":{"content":"state.summary"}}
  ]' \
  --edges '[{"from":"fetch","to":"summarise"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.orchestrations.createOrchestration({
  body: {
    project_id: 'proj_ABC',
    name: 'fetch-and-summarize',
    nodes: [
      {
        id: 'fetch',
        type: 'tool',
        tool_id: 'tool_abc',
        output_mapping: { result: 'state.raw' },
      },
      {
        id: 'summarise',
        type: 'agent',
        agent_id: 'agt_xyz',
        input_mapping: { prompt: { var: 'raw' } },
        output_mapping: { content: 'state.summary' },
      },
    ],
    edges: [{ from: 'fetch', to: 'summarise' }],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/orchestrations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "name": "fetch-and-summarize",
    "nodes": [
      {
        "id": "fetch",
        "type": "tool",
        "tool_id": "tool_abc",
        "output_mapping": {"result": "state.raw"}
      },
      {
        "id": "summarise",
        "type": "agent",
        "agent_id": "agt_xyz",
        "input_mapping": {"prompt": {"var": "raw"}},
        "output_mapping": {"content": "state.summary"}
      }
    ],
    "edges": [{"from": "fetch", "to": "summarise"}]
  }'
```

</TabItem>
</Tabs>

### Start a run

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat start-orchestration-run \
  --orchestration-id orch_01 \
  --input '{"query": "summarize Q1 revenue"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.orchestrations.startOrchestrationRun({
  body: { orchestration_id: 'orch_01', input: { query: 'summarize Q1 revenue' } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/orchestration-runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id": "orch_01", "input": {"query": "summarize Q1 revenue"}}'
```

</TabItem>
</Tabs>

### Parallel fan-out

Both `branch_a` and `branch_b` run concurrently after `start` completes:

```json
{
  "nodes": [
    { "id": "start", "type": "transform", "expression": { "var": "query" } },
    { "id": "branch_a", "type": "agent", "agent_id": "agt_a", "output_mapping": { "content": "state.a" } },
    { "id": "branch_b", "type": "agent", "agent_id": "agt_b", "output_mapping": { "content": "state.b" } }
  ],
  "edges": [
    { "from": "start", "to": "branch_a" },
    { "from": "start", "to": "branch_b" }
  ]
}
```

### Fan-in with `activation_condition: all`

`merge` runs only after **both** branches complete:

```json
{
  "edges": [
    { "from": "branch_a", "to": "merge", "activation_group": "join", "activation_condition": "all" },
    { "from": "branch_b", "to": "merge", "activation_group": "join", "activation_condition": "all" }
  ]
}
```

### Condition-based routing

```json
{
  "nodes": [
    {
      "id": "check",
      "type": "condition",
      "expression": { "if": [{ ">": [{ "var": "score" }, 0.8] }, "high", "low"] }
    },
    { "id": "high_path", "type": "agent", "agent_id": "agt_high" },
    { "id": "low_path", "type": "agent", "agent_id": "agt_low" }
  ],
  "edges": [
    { "from": "check", "to": "high_path", "condition": "high" },
    { "from": "check", "to": "low_path", "condition": "low" }
  ]
}
```
