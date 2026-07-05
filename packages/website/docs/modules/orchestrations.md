import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestrations

DAG-based workflow definitions for chaining agents, tools, and knowledge lookups into repeatable pipelines.

## Overview

Orchestrations let you describe a directed acyclic graph (DAG) of nodes where each node performs a discrete operation. Nodes in the same execution round run in parallel; edges with activation groups control fan-in convergence.

Use orchestrations when you know the exact steps in advance and want deterministic, auditable execution — not when you need an LLM to decide which steps to take. An agent node inside an orchestration can still use LLM reasoning internally, but the orchestration graph itself is deterministic. See it end to end in [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

An orchestration can also be declared as a [Formation](./formations.md) resource, letting you deploy a team of agents together with the flow that coordinates them as a single stack — see the [Agent Squad example](#agent-squad).

## Related Tutorials

- [Orchestration Control Flow: Delay, Poll, and Loop](/docs/tutorials/orchestration-control-flow) — the `delay`, `poll`, `loop`, and `condition` nodes in one deterministic run, with a reference table for every node type
- [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration) — condition nodes, branch routing, and `skipped` node executions
- [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph)
- [Orchestrate a Sonnet - Step 7 (Start a run)](/docs/tutorials/orchestrate-a-sonnet#step-7--start-a-run)
- [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state)
- [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — a team of agents plus a coordinating orchestration, deployed and run as one stack

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

| Field              | Type           | Description                                                       |
| ------------------ | -------------- | ----------------------------------------------------------------- |
| `id`               | string         | Public ID (`run_` prefix)                                         |
| `orchestration_id` | string         | Parent orchestration                                              |
| `project_id`       | string         | Owning project                                                    |
| `status`           | string         | `queued` \| `running` \| `sleeping` \| `awaiting_input` \| `succeeded` \| `failed` \| `cancelled` \| `expired` |
| `state`            | object         | Current mutable execution state                                   |
| `active_nodes`     | array          | Node IDs awaiting input or a scheduled wake (populated when `awaiting_input`, or `sleeping` while parked on a `delay`/`poll` wait) |
| `artifacts`        | object         | Outputs keyed by node ID                                          |
| `error`            | object \| null | Error details if failed                                           |
| `node_executions`  | array          | Per-node execution records (see [Node Executions](#node-executions)) |
| `required_action`  | object \| null | Present when status is `awaiting_input` (see [Human Nodes](#human-nodes)) |
| `trace_id`         | string \| null | Linked observability trace, if any                                |
| `input`            | object \| null | Initial input provided at run creation                            |
| `output`           | object \| null | Terminal node artifact(s) when the run has `succeeded`            |
| `started_at`       | string \| null | ISO 8601 execution start timestamp                                |
| `completed_at`     | string \| null | ISO 8601 terminal timestamp (`succeeded`/`failed`/`cancelled`/`expired`) |
| `created_at`       | string         | ISO 8601 creation timestamp                                       |
| `updated_at`       | string         | ISO 8601 last-updated timestamp                                   |

### NodeExecution

Each entry in a run's `node_executions` array records a single node execution, in chronological order. Together they form the execution trace of a run — the orchestration analogue of an LLM trace.

| Field          | Type           | Description                                              |
| -------------- | -------------- | -------------------------------------------------------- |
| `node_id`      | string         | ID of the executed node                                  |
| `node_type`    | string \| null | Node type (`agent`, `transform`, …)                      |
| `status`       | string         | `completed` \| `failed` \| `requires_action` \| `skipped` |
| `input`        | object \| null | Resolved `input_mapping` the node received               |
| `output`       | object \| null | Output artifact the node produced (`null` when failed)   |
| `error`        | object \| null | `{ code, message }` when `status` is `failed`            |
| `started_at`   | string \| null | ISO 8601 timestamp when the node began executing         |
| `completed_at` | string \| null | ISO 8601 timestamp when the record was written           |
| `created_at`   | string         | ISO 8601 creation timestamp                              |

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
| `human`        | Pauses the run and waits for external input. The run enters `awaiting_input` status with `requiredAction`.                          |
| `loop`         | Iterates a state collection, running a sub-orchestration per item. Uses `orchestrationId`, `collection`, `itemVariable`, and `parallelism`. See [Loops](#loops-collection-iteration). |
| `poll`         | Calls a tool on an interval until a JSON Logic exit condition on the response holds. Uses `toolId`, `exitCondition`, and `interval`. See [Polling](#polling). |
| `delay`        | Waits for a fixed `duration`, then continues. Accepts `5s`/`5m`/`2h`/`500ms` or ISO 8601 (`PT5S`).                                   |
| `webhook`      | Emits an HTTP POST (`mode: "emit"`, `webhookUrl`) or pauses awaiting a callback (`mode: "receive"`). `emit` is fire-and-forget: the POST is not awaited, and delivery success or failure is not tracked or retried — the node completes immediately with `{ emitted: true }` regardless of the outcome. |
| `sub_orchestration` | Runs another orchestration as a single step. Uses `orchestrationId`. The node's artifact is the **child run's `output`** — i.e. `{ terminalNodeId: terminalArtifact }`, the same shape used for `output` on [OrchestrationRun](#orchestrationrun) and for each item in a [`loop`](#loops-collection-iteration) node's `results` array — not a flattened value. `output_mapping`'s artifact key is a flat property lookup (it does not traverse dots), so `{"childNode": "state.x"}` copies the whole `{ terminalNodeId: terminalArtifact }` object into `state.x`; pull out a deeper field with a following `transform` node reading `{"var": "x.terminalNodeId.someField"}`. |

### Loops (collection iteration)

A `loop` node iterates an array in the run state and runs a **sub-orchestration once per item**. It is the collection counterpart to `poll` (which repeats until a condition).

| Field | Default | Purpose |
| --- | --- | --- |
| `orchestrationId` | — (required) | Public ID of the orchestration to run for each item (same field the `sub_orchestration` node uses) |
| `collection` | `state.items` | State path to the array to iterate; a path without the `state.` prefix is normalised to one. A missing or non-array value yields zero iterations |
| `itemVariable` | `item` | Each element is passed as the sub-run's **input** under this key, so the sub-graph reads it with `{"var": "item"}` |
| `parallelism` | `5` | Items are processed in batches of this size |

The node completes with an artifact `{ results: [...] }` — one entry per item, in order, holding that sub-run's `output`. A graph containing a `loop` node is exempt from [cycle detection](#static-validation) (loops introduce intentional cycles).

```json
{
  "id": "summarise_each",
  "type": "loop",
  "orchestration_id": "orch_summariseOne",
  "collection": "state.documents",
  "item_variable": "doc",
  "parallelism": 3,
  "output_mapping": { "results": "state.summaries" }
}
```

### Polling

A `poll` node repeatedly calls a [Tool](./tools.md) until a [JSON Logic](https://jsonlogic.com) **exit condition** on its response is satisfied. It is the condition-based counterpart to `loop` (which iterates a known collection).

Each attempt:

1. Calls `toolId` (resolving `inputMapping` against state, like a `tool` node).
2. Evaluates `exitCondition` against an **augmented context** — the run state plus `response` (the latest tool result) and `attempt` (1-based count). A truthy result stops polling.
3. Otherwise the `interval` becomes a **scheduled resumption**: the run is parked and the background scheduler drives the next attempt after `interval`, bounded by `maxIterations` (default 10, ceiling 1000). There is no wall-clock ceiling — the wait no longer holds an HTTP request open, so a poll can span hours or days.

The node completes with an artifact `{ result, attempts, conditionMet, timedOut }`. On exhaustion it completes with `conditionMet: false` (branch on it downstream with a `condition` node) — unless `failOnTimeout: true`, which fails the run with `ORCHESTRATION_POLL_EXHAUSTED`.

```json
{
  "id": "wait_for_render",
  "type": "poll",
  "tool_id": "tool_renderStatus",
  "input_mapping": { "id": { "var": "jobId" } },
  "exit_condition": { "==": [{ "var": "response.status" }, "completed"] },
  "interval": "5s",
  "max_iterations": 60,
  "output_mapping": { "result": "state.render" }
}
```

> **Note:** `poll` and `delay` waits are offloaded to the background scheduler (see [Durable Background Execution](#durable-background-execution)). They do not hold an HTTP request open, and a run parked on a wait survives a server restart.

### Durable Background Execution

Runs execute in a **durable background worker**, detached from the HTTP request that starts them:

- `start-orchestration-run` persists the run and returns immediately with `status: "running"`. Observe progress with `get-orchestration-run` (which includes `node_executions`) or via run lifecycle [webhook](./webhooks.md) events.
- `delay` and `poll` waits park the run as **`sleeping`** — it holds no worker and no memory, pure DB state. The wake time (`wake_at`) and how to continue are persisted with the run, and the scheduler wakes it when the wait is due — so a run containing `delay: "2h"` survives a restart and completes on schedule.
- `human` and `webhook (mode: receive)` nodes park the run as **`awaiting_input`** (also pure DB state, no worker); resume them with `submit-human-input` or `resume-orchestration-run`.

**Synchronous (compatibility) mode.** Pass `wait: true` to `start-orchestration-run` to block until the run reaches a terminal (`succeeded`/`failed`) or `awaiting_input` state, sleeping through any delay/poll waits in-process. This preserves the legacy behaviour for callers (and tests) that need the settled run in the response. Nested `loop` and `sub_orchestration` runs always execute synchronously so their output can be aggregated.

**Lifecycle events.** The following events are emitted through the [Webhooks](./webhooks.md) module so callers do not need to poll:

| Event                                | When                                          |
| ------------------------------------ | --------------------------------------------- |
| `orchestration_runs.started`         | A run is created and begins executing         |
| `orchestration_runs.awaiting_input`  | A run pauses on a `human`/`webhook` node      |
| `orchestration_runs.succeeded`       | A run reaches `succeeded`                      |
| `orchestration_runs.failed`          | A run reaches `failed`                        |

The scheduler tick interval is configurable with the `ORCHESTRATION_SCHEDULER_INTERVAL_MS` environment variable (default `5000`).

### State and Mappings

Each node can define:

- **`inputMapping`** — Maps node input keys to values resolved against the run state before execution. Each value is [JSON Logic](https://jsonlogic.com) (see [Input Mapping](#input-mapping-json-logic)).
- **`outputMapping`** — Maps node outputs back to state paths after execution. Each value should be a string starting with the literal `state.` prefix (e.g. `"state.summary"`); a value without the prefix (e.g. `"summary"`) is normalized to be state-relative, the same convention `loop.collection` already uses. Prefer the explicit `state.`-prefixed form shown in the examples throughout this page.

The root state is available to every node. Transforms and conditions receive the full state object.

#### Input Mapping (JSON Logic)

Each `inputMapping` value is evaluated as [JSON Logic](https://jsonlogic.com) against the run state — the same evaluator used by `transform` and `condition` nodes. This gives one expression language across the whole platform: pass literals, read state, or compute derived values inline, without a dedicated `transform` node.

| Value | Behaviour |
| ----- | --------- |
| String, number, boolean | Passed through as a literal |
| A single-key object whose key names a JSON Logic operator (`var`, `cat`, `if`, `>`, arithmetic, …) | Evaluated against state |
| Any other object or array | Passed through as a literal, but recursed into — a JSON Logic marker nested inside it (at any depth) is still resolved |

```json
"input_mapping": {
  "language": "pt-BR",
  "threshold": 0.8,
  "documentId": { "var": "temaDocumentId" },
  "label": { "cat": ["Tema: ", { "var": "titulo" }] },
  "isLong": { ">": [{ "var": "wordCount" }, 500] },
  "data": { "title": { "var": "titulo" }, "theme": { "var": "tema" } }
}
```

Values passed to [`start-orchestration-run`](#examples) via `input` become the initial state, so a node can reference them directly with `{"var": "key"}`.

To pass a literal object that happens to look like a JSON Logic expression — e.g. the JSON Logic object `{"var": "x"}` itself, as data rather than an expression to evaluate — wrap it in `preserve`, which returns its argument unevaluated: `{"preserve": {"var": "x"}}`.

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

A DFS-based cycle check runs both at create/update time (see [Static Validation](#static-validation)) and again before a run begins. Orchestrations that contain a `loop` node are exempt — loops introduce intentional cycles. If a cycle reaches execution anyway, the run is created, set to `failed`, and the `error` field contains `code: "ORCHESTRATION_CYCLE_DETECTED"`.

### Static Validation

Orchestration graphs are validated **before** they are persisted. `create-orchestration` and `update-orchestration` reject an invalid graph with HTTP `400` (`code: "ORCHESTRATION_VALIDATION_FAILED"`); the `error.meta` field carries the full `errors` and `warnings` arrays. The same checks are available without persisting through `validate-orchestration`, which returns a `{ valid, errors, warnings }` result.

**Errors (block create/update):**

| Check | Example |
| ----- | ------- |
| Node missing its required field | an `agent` node without `agent_id`, a `transform`/`condition` node without `expression` |
| Duplicate node id | two nodes share `id: "a"` |
| Dangling edge | an edge whose `from`/`to` references a node that does not exist |
| Cycle (no `loop` node present) | `a → b → a` |
| Unsatisfiable `input_mapping` reference | a `{"var": "x"}` whose `state.x` is never written by an upstream node **and** `input_schema` is declared but does not list `x` |

**Warnings (never block):**

| Check | Example |
| ----- | ------- |
| Conditional-branch state read | a node reads `{"var": "branch"}` that an upstream node writes only on one side of a `condition`, so it may be undefined when the node runs |

The `input_mapping` reachability check only treats an unwritten reference as an **error** when an `input_schema` is declared (a closed input contract). Without an `input_schema`, the run input is an open contract — the key may be supplied at run time — so the reference is allowed. The check walks the graph's edges to determine which nodes are upstream, and uses dominator analysis to distinguish a key that is guaranteed-written from one written only on a conditional branch.

```bash
soat validate-orchestration \
  --nodes '[{"id":"a","type":"transform","expression":1,"output_mapping":{"result":"state.step1"}},
            {"id":"b","type":"transform","expression":1,"input_mapping":{"val":{"var":"step1"}}}]' \
  --edges '[{"from":"a","to":"b"}]'
# → { "valid": true, "errors": [], "warnings": [] }
```

### Node Executions

Every time a node runs, the engine persists an entry in the run's `node_executions` array capturing the resolved `input_mapping` it received, the `output` artifact it produced, its `status`, and — on failure — the structured `error`. The record is written even when a node throws, so a failed run is fully debuggable: `get-orchestration-run` shows **which** node failed, **what** input it received, and **why**, instead of only the final state plus a single error message.

When a run completes, nodes that were never reached (because they were on an un-traversed condition branch or an activation group that never fired) are recorded with `status: "skipped"`. Their `input`, `output`, `started_at`, and `completed_at` fields are all `null`. This makes every declared node visible in the execution trace regardless of which branches ran. Walk through it end to end in [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration).

```json
{
  "status": "failed",
  "error": { "code": "ORCHESTRATION_NODE_FAILED", "message": "Agent 'agt_x' not found." },
  "node_executions": [
    {
      "node_id": "fetch",
      "node_type": "tool",
      "status": "completed",
      "input": { "url": "https://example.com" },
      "output": { "result": "..." }
    },
    {
      "node_id": "summarise",
      "node_type": "agent",
      "status": "failed",
      "input": { "prompt": "..." },
      "output": null,
      "error": { "code": "ORCHESTRATION_NODE_FAILED", "message": "Agent 'agt_x' not found." }
    }
  ]
}
```

Records are returned by both `get-orchestration-run` and `list-orchestration-runs`, ordered oldest-first. A node that pauses the run for human input is recorded with `status: "requires_action"`; once `submit-human-input` (or `resume-orchestration-run`) satisfies the pause, that same record is updated to `status: "completed"` with `output` set to the submitted payload and `completed_at` set to the resume time — it is never left behind as `requires_action` in a finished run. A node that was never reached is recorded with `status: "skipped"` once the run completes. For a worked example of reading back the accumulated state and per-node output of a finished run, see [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state).

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

`required_action.type` discriminates why the run paused: `human_input` for a `human` node, `webhook_receive` for a `webhook` node in `mode: "receive"`. Both pause reasons are resumed the same way — `POST /orchestration-runs/{id}/human-input` with the paused node's `node_id` — there is currently no separate, independently-authenticated callback endpoint for webhook-receive nodes, so delivering the callback requires the same platform bearer token or API key as any other write to the run.

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

Returns immediately with `status: "running"`; the run executes in the background. Add `wait: true` (`--wait` in the CLI) to block until the run settles (see [Durable Background Execution](#durable-background-execution)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Async (default): returns a "running" run immediately
soat start-orchestration-run \
  --orchestration-id orch_01 \
  --input '{"query": "summarize Q1 revenue"}'

# Synchronous: block until the run completes or pauses
soat start-orchestration-run \
  --orchestration-id orch_01 \
  --input '{"query": "summarize Q1 revenue"}' \
  --wait
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.orchestrations.startOrchestrationRun({
  // omit `wait` (or pass false) for background execution
  body: { orchestration_id: 'orch_01', input: { query: 'summarize Q1 revenue' }, wait: true },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/orchestration-runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"orchestration_id": "orch_01", "input": {"query": "summarize Q1 revenue"}, "wait": true}'
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

A `condition` node emits a string label; edges carry `condition: "<label>"` to select the active branch. The unselected branch's nodes are recorded as `skipped`. For a runnable walkthrough, see [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration).

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

### Agent Squad

A team of agents plus the flow that coordinates them can deploy as a single [Formation](./formations.md) stack, because an orchestration is itself a formation resource type. A node's `agent_id` uses a [`ref` expression](./formations.md#ref-expressions) to bind to an agent created in the same template; SOAT resolves it to the physical `agt_...` ID before the orchestration is created. Node fields are written in snake_case (`agent_id`, `input_mapping`, `output_mapping`), exactly as in this module's REST contract. For a full step-by-step build, see [Create an Agent Squad](/docs/tutorials/create-an-agent-squad).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
cat > squad.json << 'EOF'
{
  "resources": {
    "Provider": {
      "type": "ai_provider",
      "properties": { "name": "OpenAI", "provider": "openai", "default_model": "gpt-4o" }
    },
    "Writer": {
      "type": "agent",
      "properties": {
        "name": "Writer",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "Draft a short article on the given topic."
      }
    },
    "Reviewer": {
      "type": "agent",
      "properties": {
        "name": "Reviewer",
        "ai_provider_id": { "ref": "Provider" },
        "instructions": "Tighten and fact-check the draft."
      }
    },
    "ContentSquad": {
      "type": "orchestration",
      "properties": {
        "name": "content-squad",
        "input_schema": { "type": "object", "properties": { "topic": { "type": "string" } } },
        "nodes": [
          {
            "id": "write",
            "type": "agent",
            "agent_id": { "ref": "Writer" },
            "input_mapping": { "prompt": { "var": "topic" } },
            "output_mapping": { "content": "state.draft" }
          },
          {
            "id": "review",
            "type": "agent",
            "agent_id": { "ref": "Reviewer" },
            "input_mapping": { "prompt": { "var": "draft" } },
            "output_mapping": { "content": "state.final" }
          }
        ],
        "edges": [{ "from": "write", "to": "review" }]
      }
    }
  },
  "outputs": {
    "squad_id": { "ref": "ContentSquad" }
  }
}
EOF

FORMATION=$(soat create-formation \
  --project-id "$PROJECT_ID" \
  --name "content-squad" \
  --template-file squad.json)

SQUAD_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.squad_id')

soat start-orchestration-run \
  --orchestration-id "$SQUAD_ID" \
  --input '{"topic": "agent squads"}' \
  --wait
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const template = {
  resources: {
    Provider: {
      type: 'ai_provider',
      properties: { name: 'OpenAI', provider: 'openai', default_model: 'gpt-4o' },
    },
    Writer: {
      type: 'agent',
      properties: {
        name: 'Writer',
        ai_provider_id: { ref: 'Provider' },
        instructions: 'Draft a short article on the given topic.',
      },
    },
    Reviewer: {
      type: 'agent',
      properties: {
        name: 'Reviewer',
        ai_provider_id: { ref: 'Provider' },
        instructions: 'Tighten and fact-check the draft.',
      },
    },
    ContentSquad: {
      type: 'orchestration',
      properties: {
        name: 'content-squad',
        input_schema: { type: 'object', properties: { topic: { type: 'string' } } },
        nodes: [
          {
            id: 'write',
            type: 'agent',
            agent_id: { ref: 'Writer' },
            input_mapping: { prompt: { var: 'topic' } },
            output_mapping: { content: 'state.draft' },
          },
          {
            id: 'review',
            type: 'agent',
            agent_id: { ref: 'Reviewer' },
            input_mapping: { prompt: { var: 'draft' } },
            output_mapping: { content: 'state.final' },
          },
        ],
        edges: [{ from: 'write', to: 'review' }],
      },
    },
  },
  outputs: { squad_id: { ref: 'ContentSquad' } },
};

const { data: formation } = await soat.formations.createFormation({
  body: { project_id: 'proj_ABC', name: 'content-squad', template },
});
const SQUAD_ID = formation.outputs?.squad_id as string;

const { data: run } = await soat.orchestrations.startOrchestrationRun({
  body: { orchestration_id: SQUAD_ID, input: { topic: 'agent squads' }, wait: true },
});
if (run.error) throw new Error(JSON.stringify(run.error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FORMATION=$(curl -s -X POST https://api.example.com/api/v1/formations \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\": \"proj_ABC\", \"name\": \"content-squad\", \"template\": $(cat squad.json)}")

SQUAD_ID=$(printf '%s' "$FORMATION" | jq -r '.outputs.squad_id')

curl -X POST https://api.example.com/api/v1/orchestration-runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"orchestration_id\": \"$SQUAD_ID\", \"input\": {\"topic\": \"agent squads\"}, \"wait\": true}"
```

</TabItem>
</Tabs>

Deploying this template creates the provider, both agents, and the orchestration in dependency order. Running it with `{ "topic": "..." }` as input drives `write` then `review` and leaves the final draft at `state.final`.
