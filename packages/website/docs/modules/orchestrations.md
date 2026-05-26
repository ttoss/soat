# Orchestrations

## Overview

The Orchestrations module lets you define and execute **DAG-based workflows** — directed acyclic graphs (DAGs) of nodes where each node performs a discrete operation. Nodes in the same execution round run in parallel; edges with activation groups control fan-in convergence. Orchestrations are useful for chaining agents, tools, transforms, and knowledge lookups into a repeatable, auditable workflow.

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Key Concepts

### Orchestration

An **Orchestration** is a reusable pipeline definition. It contains:

- **`nodes`** — An ordered list of processing steps (see Node Types below).
- **`edges`** — Directed connections between nodes. An edge `{ from, to }` means the output of `from` feeds into `to`. Edges can carry an optional `condition` label for routing after a `condition` node, and an `activation_group` / `activation_condition` pair for fan-in convergence.
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

### Parallel Execution

All nodes that become active in the same round are executed concurrently via `Promise.all`. After all complete, their outputs and state mutations are applied sequentially to avoid races. This enables true fan-out: a single node with multiple outgoing edges activates all targets in parallel.

### Activation Groups (Fan-In)

Edges can carry an `activation_group` name and an `activation_condition` value to control when a downstream node is allowed to run:

| `activation_condition` | Behaviour                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default)        | The target node activates only after **every** edge in the group comes from a completed node.                                     |
| `any`                  | The target node activates as soon as **any** edge in the group comes from a completed node. It is activated at most once per run. |

Edges without an `activation_group` always pass through unconditionally.

### Cycle Detection

Before execution begins, the engine performs a DFS-based cycle check on the graph. If a cycle is detected the run is created immediately, set to `failed`, and the `error` field contains `code: "ORCHESTRATION_CYCLE_DETECTED"`. Self-loops are caught by the same check.

### Node Types

| Type           | Description                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`        | Invokes a SOAT agent with a prompt. Uses `agentId` and `prompt`.                                                                                                           |
| `tool`         | Calls a SOAT tool. Uses `toolId` and `inputMapping`.                                                                                                                       |
| `transform`    | Evaluates a [JSON Logic](https://jsonlogic.com) rule against the current state. Uses `expression`.                                                                         |
| `knowledge`    | Searches a knowledge source. Uses `inputMapping` with `query` and optional `memoryIds`.                                                                                    |
| `memory_write` | Writes a memory entry. Uses `memoryId` and `inputMapping` with `content`.                                                                                                  |
| `condition`    | Evaluates a [JSON Logic](https://jsonlogic.com) rule and emits a string label. Downstream edges use `condition: "<label>"` to select the active branch. Uses `expression`. |
| `human`        | Pauses the run and waits for external input. The run enters `paused` status with `requiredAction`.                                                                         |

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
| `active_nodes`     | array          | Node IDs awaiting input (populated when status is `paused`)     |
| `artifacts`        | object         | Outputs keyed by node ID                                        |
| `error`            | object \| null | Error details if failed                                         |
| `current_node_id`  | string \| null | Most recently executed node ID                                  |
| `required_action`  | object \| null | Present when status is `paused`                                 |
| `created_at`       | string         | ISO 8601 timestamp                                              |
| `updated_at`       | string         | ISO 8601 timestamp                                              |

## Examples

### Sequential pipeline

```json
{
  "nodes": [
    {
      "id": "fetch",
      "type": "tool",
      "tool_id": "tl_…",
      "output_mapping": { "result": "state.raw" }
    },
    {
      "id": "summarise",
      "type": "agent",
      "agent_id": "agt_…",
      "input_mapping": { "prompt": "state.raw" },
      "output_mapping": { "content": "state.summary" }
    }
  ],
  "edges": [{ "from": "fetch", "to": "summarise" }]
}
```

### Parallel fan-out

Both `branch_a` and `branch_b` run concurrently after `start` completes.

```json
{
  "nodes": [
    { "id": "start", "type": "transform", "expression": { "var": "query" } },
    {
      "id": "branch_a",
      "type": "agent",
      "agent_id": "agt_…",
      "output_mapping": { "content": "state.a" }
    },
    {
      "id": "branch_b",
      "type": "agent",
      "agent_id": "agt_…",
      "output_mapping": { "content": "state.b" }
    }
  ],
  "edges": [
    { "from": "start", "to": "branch_a" },
    { "from": "start", "to": "branch_b" }
  ]
}
```

### Fan-in with `activation_condition: all`

`merge` runs only after **both** `branch_a` and `branch_b` complete.

```json
{
  "edges": [
    {
      "from": "branch_a",
      "to": "merge",
      "activation_group": "join",
      "activation_condition": "all"
    },
    {
      "from": "branch_b",
      "to": "merge",
      "activation_group": "join",
      "activation_condition": "all"
    }
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
      "expression": {
        "if": [{ ">": [{ "var": "score" }, 0.8] }, "high", "low"]
      }
    },
    { "id": "high_path", "type": "agent", "agent_id": "agt_…" },
    { "id": "low_path", "type": "agent", "agent_id": "agt_…" }
  ],
  "edges": [
    { "from": "check", "to": "high_path", "condition": "high" },
    { "from": "check", "to": "low_path", "condition": "low" }
  ]
}
```

## Design Decisions

### Why not embed orchestration logic in agents?

Agents are LLM-powered reasoning engines. Using an LLM to decide "call tool A, then tool B, then tool C" when you know the exact sequence is wasteful (cost), slow (latency), and unreliable (the LLM might skip steps or change order).

Orchestrations separate **what to do** (deterministic graph) from **how to think** (LLM in agent nodes).

### Why typed state instead of message passing?

Message passing (conversation history) works for chat but fails for structured workflows:

- Messages are untyped text — downstream nodes have to "understand" what upstream sent.
- Message history grows linearly — later nodes see irrelevant early context.
- There is no way to express "take field X from step 2 and field Y from step 5".

Typed state gives each node exactly the inputs it needs, in the exact structure it expects.

### Why separate from sessions?

Sessions are conversational (append-only message history, turn-based). Orchestrations are workflow-oriented (directed graph, state accumulation, parallel execution). They serve different use cases:

- **Session:** "Chat with a customer support agent."
- **Orchestration:** "Process this insurance claim through 7 steps with 3 approval gates."

An agent node inside an orchestration may internally use a session for multi-turn reasoning, but the orchestration itself is not a conversation.

### Expression language

`transform` and `condition` nodes evaluate expressions using [JSON Logic](https://jsonlogic.com) — a JSON-serializable, side-effect-free expression format with no `eval`, no imports, and no access to the runtime environment. The full state object is passed as the data context, so any state field is reachable via `{ "var": "fieldName" }`.
