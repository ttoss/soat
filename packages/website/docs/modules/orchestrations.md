# Orchestrations

## Overview

The Orchestrations module lets you define and execute **linear pipelines** — directed acyclic graphs (DAGs) of nodes where each node performs a discrete operation and passes results to the next. Orchestrations are useful for chaining agents, tools, transforms, and knowledge lookups into a repeatable, auditable workflow.

## Key Concepts

### Orchestration

An **Orchestration** is a reusable pipeline definition. It contains:

- **`nodes`** — An ordered list of processing steps (see Node Types below).
- **`edges`** — Directed connections between nodes. An edge `{ source, target }` means the output of `source` feeds into `target`.
- **`stateSchema`** — Optional JSON Schema describing the expected shape of the run state.
- **`inputSchema`** — Optional JSON Schema describing the expected shape of the run input.

### Orchestration Run

An **OrchestrationRun** is a single execution of an Orchestration. It stores:

- **`status`** — `running`, `paused`, `completed`, `failed`, or `cancelled`.
- **`state`** — The mutable execution state passed between nodes.
- **`activeNodes`** — Node IDs currently waiting for external input (used for `human` nodes).
- **`artifacts`** — Outputs produced by each node, keyed by node ID.
- **`error`** — Error details if the run failed.
- **`currentNodeId`** — ID of the node currently executing (or last executed).

### Node Types

| Type           | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `agent`        | Invokes a SOAT agent with a prompt. Uses `agentId` and `prompt`.                                   |
| `tool`         | Calls a SOAT tool. Uses `toolId` and `inputMapping`.                                               |
| `transform`    | Evaluates a JavaScript expression against the current state. Uses `expression`.                    |
| `knowledge`    | Searches a knowledge source. Uses `inputMapping` with `query` and optional `memoryIds`.            |
| `memory_write` | Writes a memory entry. Uses `memoryId` and `inputMapping` with `content`.                          |
| `condition`    | Evaluates a boolean expression and routes to `trueTarget` or `falseTarget`. Uses `expression`.     |
| `human`        | Pauses the run and waits for external input. The run enters `paused` status with `requiredAction`. |

### State and Mappings

Each node can define:

- **`inputMapping`** — Maps state paths (JSONPath-like `$.key`) to node inputs before execution.
- **`outputMapping`** — Maps node outputs back to state paths after execution.

The root state is available to every node. Transforms and conditions receive the full state object.

### Human Nodes and `requiredAction`

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

Resuming human-node runs is a Phase 2 feature.

## Data Model

### Orchestration

| Field          | Type           | Description               |
| -------------- | -------------- | ------------------------- |
| `id`           | string         | Public ID (`orch_…`)      |
| `project_id`   | string         | Owning project            |
| `name`         | string         | Human-readable name       |
| `description`  | string \| null | Optional description      |
| `nodes`        | array          | Node definitions          |
| `edges`        | array          | Edge definitions          |
| `state_schema` | object         | JSON Schema for run state |
| `input_schema` | object         | JSON Schema for run input |
| `created_at`   | string         | ISO 8601 timestamp        |
| `updated_at`   | string         | ISO 8601 timestamp        |

### OrchestrationRun

| Field              | Type           | Description                                                     |
| ------------------ | -------------- | --------------------------------------------------------------- |
| `id`               | string         | Public ID (`run_…`)                                             |
| `orchestration_id` | string         | Parent orchestration                                            |
| `status`           | string         | `running` \| `paused` \| `completed` \| `failed` \| `cancelled` |
| `state`            | object         | Current execution state                                         |
| `active_nodes`     | array          | Node IDs awaiting input                                         |
| `artifacts`        | object         | Outputs keyed by node ID                                        |
| `error`            | object \| null | Error details if failed                                         |
| `current_node_id`  | string \| null | Most recent node ID                                             |
| `required_action`  | object \| null | Present when status is `paused`                                 |
| `created_at`       | string         | ISO 8601 timestamp                                              |
| `updated_at`       | string         | ISO 8601 timestamp                                              |
