---
description: "DAG-based pipeline definitions that chain agents, tools, and knowledge lookups into repeatable pipelines."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestrations

DAG-based pipeline definitions for chaining agents, tools, and knowledge lookups into repeatable pipelines.

## Orchestration or workflow?

An **orchestration is a pipeline that _ends_** — a directed acyclic graph that starts, flows forward through its nodes, and terminates. A **[workflow](./workflows.md) is a state graph a task _lives_ in** — a long-lived entity that moves between named states over days or weeks, including backward.

| You want… | Use |
| --- | --- |
| A deterministic, forward-only sequence of steps that runs and completes | **Orchestration** (this module) |
| Statuses, transitions, guards, a kanban board, or an entity that revisits states | **[Workflows](./workflows.md)** |

The two compose: when a task enters a state, it may _dispatch_ an orchestration (or an agent) to do that state's work. See [Workflows & Tasks](./workflows.md).

## Overview

Orchestrations let you describe a directed acyclic graph (DAG) of nodes where each node performs a discrete operation. Nodes in the same execution round run in parallel; edges with activation groups control fan-in convergence.

Use orchestrations when you know the exact steps in advance and want deterministic, auditable execution — not when you need an LLM to decide which steps to take. An agent node inside an orchestration can still use LLM reasoning internally, but the orchestration graph itself is deterministic. See it end to end in [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph).

> See the [Permissions Reference](../permissions.md#orchestrations) for the IAM action strings for this module.

An orchestration can also be declared as a [Formation](./formations.md) resource, letting you deploy a team of agents together with the flow that coordinates them as a single stack — see the [Agent Squad example](#agent-squad).

To run an orchestration automatically — on a cron schedule, in response to an inbound webhook, or on demand — bind it to a [Trigger](./triggers.md) with `target_type: orchestration`.

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
| `id`               | string         | Public ID (`orch_run_` prefix)                                    |
| `orchestration_id` | string         | Parent orchestration                                              |
| `project_id`       | string         | Owning project                                                    |
| `status`           | string         | `queued` \| `running` \| `sleeping` \| `awaiting_input` \| `succeeded` \| `failed` \| `cancelled` \| `expired` |
| `state`            | object         | Current mutable execution state                                   |
| `active_nodes`     | array          | Node IDs awaiting input or a scheduled wake (populated when `awaiting_input`, or `sleeping` while parked on a `delay`/`poll` wait) |
| `artifacts`        | object         | Outputs keyed by node ID                                          |
| `error`            | object \| null | Error details if failed                                           |
| `node_executions`  | array          | Per-node execution records (see [Node Executions](#node-executions)) |
| `usage`            | object         | Token/cost roll-up (`total_input_tokens`, `total_output_tokens`, `total_cached_tokens`, `total_reasoning_tokens`, `total_cost_usd`) summed across every metered generation the run produced (see [Run usage](#run-usage)). Present on the single-run read; omitted from run list responses |
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
| `attempt`      | integer        | 1-based attempt number (a retried node yields one record per attempt) |
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
| `agent`        | Invokes a SOAT [Agent](./agents.md) with a prompt. Uses `agent_id` and `prompt`.                                                    |
| `tool`         | Calls a SOAT [Tool](./tools.md). Uses `tool_id` and `input_mapping`.                                                                 |
| `transform`    | Evaluates a [JSON Logic](https://jsonlogic.com) rule against the current state. Uses `expression`.                                  |
| `knowledge`    | Searches a knowledge source via the [Knowledge](./knowledge.md) module. Uses `input_mapping` with `query` and optional `memory_ids`. |
| `memory_write` | Writes a [Memory](./memories.md) entry. Uses `memory_id` and `input_mapping` with `content`.                                        |
| `condition`    | Evaluates a JSON Logic rule and emits a string label. Downstream edges use `condition: "<label>"` to select the active branch.      |
| `human`        | Pauses the run and waits for external input. The run enters `awaiting_input` status with `required_action`.                         |
| `approval`     | Proposes a guarded tool call and pauses for a human decision via the [Approvals](./approvals.md) queue. Uses `tool_id`, `arguments`, and `expires_in`. See [Approval Nodes](#approval-nodes).                         |
| `loop`         | Iterates a state collection, running a sub-orchestration per item. Uses `orchestration_id`, `collection`, `item_variable`, and `parallelism`. See [Loops](#loops-collection-iteration). |
| `poll`         | Calls a tool on an interval until a JSON Logic exit condition on the response holds. Uses `tool_id`, `exit_condition`, and `interval`. See [Polling](#polling). |
| `delay`        | Waits for a fixed `duration`, then continues. Accepts `5s`/`5m`/`2h`/`500ms` or ISO 8601 (`PT5S`).                                   |
| `emit_event`   | Emits an internal event of type `event_type` carrying the `input_mapping` result as the event `data`. Any [Webhook](./webhooks.md) subscribed to that event type in the run's project delivers it — signed, retried, and tracked by the Webhooks module. The graph holds no URL or secret. Fire-and-forget: the run does not block on or fail from delivery. See [Emitting events](#emitting-events). |
| `webhook`      | Pauses awaiting an inbound callback (`mode: "receive"`). The run enters `awaiting_input` with `required_action.type: "webhook_receive"`; resume it via `human-input`. (To send data _out_ of a graph, use `emit_event`.) |
| `sub_orchestration` | Runs another orchestration as a single step. Uses `orchestration_id`. The node's artifact is the **child run's `output`** — i.e. `{ terminalNodeId: terminalArtifact }`, the same shape used for `output` on [OrchestrationRun](#orchestrationrun) and for each item in a [`loop`](#loops-collection-iteration) node's `results` array — not a flattened value. `state_mapping` values are JSON Logic, whose `var` reader descends dot-paths, so `{"var": "output.terminalNodeId.someField"}` pulls a deep field directly — no extra `transform` node needed. |

### Loops (collection iteration)

A `loop` node iterates an array in the run state and runs a **sub-orchestration once per item**. It is the collection counterpart to `poll` (which repeats until a condition).

| Field | Default | Purpose |
| --- | --- | --- |
| `orchestration_id` | — (required) | Public ID of the orchestration to run for each item (same field the `sub_orchestration` node uses) |
| `collection` | `state.items` | State path to the array to iterate; a path without the `state.` prefix is normalised to one. A missing or non-array value yields zero iterations |
| `item_variable` | `item` | Each element is passed as the sub-run's **input** under this key; run input is seeded under the `input` namespace, so the sub-graph reads it with `{"var": "input.item"}` |
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
  "state_mapping": { "state.summaries": { "var": "output.results" } }
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
  "state_mapping": { "state.render": { "var": "output.result" } }
}
```

> **Note:** `poll` and `delay` waits are offloaded to the background scheduler (see [Durable Background Execution](#durable-background-execution)). They do not hold an HTTP request open, and a run parked on a wait survives a server restart.

### Emitting events

To send data out of a graph, an `emit_event` node emits an **internal event** — it does not call any URL itself. Delivery is entirely the [Webhooks](./webhooks.md) module's job: any webhook subscribed to the event type (in the run's project) delivers the event, already signed (`X-Soat-Signature`), retried, tracked as a `WebhookDelivery`, and policy-gated. The graph therefore holds **no URL and no secret** — auth and endpoints are managed once, centrally, on the webhook subscription.

- **`event_type`** — the event type to emit, e.g. `guardrail.exception`. A subscriber listens with `create-webhook --events "guardrail.exception"` (or a pattern like `guardrail.*`).
- **`input_mapping`** — resolved against run state to build the event `data` payload.

The node is reactive and fire-and-forget, exactly like the run's own [lifecycle events](#durable-background-execution): it completes as soon as the event is emitted, and the run neither blocks on nor fails from any subscriber's delivery outcome. Its artifact is `{ emitted: true, eventType: "<type>" }`. (If a graph needs a _synchronous_ call whose failure must fail the run, use an `http` [tool](./tools.md) node instead — that is a tool call, not a notification.)

```json
{
  "id": "alert",
  "type": "emit_event",
  "event_type": "guardrail.exception",
  "input_mapping": { "reason": { "var": "state.exception" } }
}
```

The emitted event carries `resource_type: "orchestration_run"` and the run's id as `resource_id`, so subscribers (and webhook policies) can scope to orchestration output. See [Delivery](./webhooks.md#delivery) for the envelope and signature format.

### Retry Policy

Any node can declare a `retry` policy. When the node throws a **transient** error and attempts remain, the run parks as `sleeping` and re-executes the node after a backoff delay (offloaded to the scheduler, exactly like `poll`/`delay` — so retries survive a restart and hold no worker). Absent, or `max_attempts <= 1`, is fail-fast (today's behaviour).

**Retriable vs terminal.** Unexpected/infrastructure errors (network, timeouts, provider SDK throws) and upstream `5xx` errors are **retriable**. Deliberate `4xx` business errors (validation, not found, conflict) are **terminal** and fail the run immediately without consuming attempts.

**Attempt history.** Each attempt writes its own `node_executions` record with an incrementing `attempt` — failed attempts `1..N-1` followed by a final `completed` (success) or `failed` (retries exhausted, run fails).

| Field | Type | Description |
| --- | --- | --- |
| `max_attempts` | integer | Total attempts including the first (default `1`, ceiling `20`). |
| `backoff.strategy` | string | `fixed` (constant `delay_ms`) or `exponential` (doubles per prior attempt). Default `fixed`. |
| `backoff.delay_ms` | integer | Base delay between attempts in ms (default `1000`). |
| `backoff.max_delay_ms` | integer | Cap on the computed backoff delay in ms (default `300000`). |

```json
{
  "id": "call_flaky_api",
  "type": "tool",
  "tool_id": "tool_upstream",
  "retry": {
    "max_attempts": 4,
    "backoff": { "strategy": "exponential", "delay_ms": 1000, "max_delay_ms": 60000 }
  }
}
```

> **Note:** node execution is not yet idempotent across a retry (or a reaper redrive) — a node with external side effects may repeat them. Run-scoped idempotency keys arrive with the queue-backed worker.

### Durable Background Execution

Runs execute in a **durable background worker**, detached from the HTTP request that starts them:

- `start-orchestration-run` persists the run and returns immediately with `status: "running"`. Observe progress with `get-orchestration-run` (which includes `node_executions`) or via run lifecycle [webhook](./webhooks.md) events.
- `delay` and `poll` waits park the run as **`sleeping`** — it holds no worker and no memory, pure DB state. The wake time (`wake_at`) and how to continue are persisted with the run, and the scheduler wakes it when the wait is due — so a run containing `delay: "2h"` survives a restart and completes on schedule.
- `human` and `webhook (mode: receive)` nodes park the run as **`awaiting_input`** (also pure DB state, no worker); resume them with `submit-human-input` or `resume-orchestration-run`.

**Crash recovery.** While a run is `running` it holds a **lease** — `lease_expires_at` is set when execution starts and refreshed after every completed round (every checkpoint). If the process driving a run crashes or is redeployed mid-execution, it stops refreshing the lease. A background reaper reclaims runs whose lease has expired and **re-drives them from the last checkpoint**, not from scratch: completed nodes are skipped and only the unfinished frontier re-executes. A healthy long run is never reclaimed because it refreshes its lease each round. (Node execution is not yet idempotent across a redrive; run-scoped idempotency keys arrive with the queue-backed worker.)

**Synchronous (compatibility) mode.** Pass `wait: true` to `start-orchestration-run` to block until the run reaches a terminal (`succeeded`/`failed`) or `awaiting_input` state, sleeping through any delay/poll waits in-process. This preserves the legacy behaviour for callers (and tests) that need the settled run in the response. Nested `loop` and `sub_orchestration` runs always execute synchronously so their output can be aggregated.

**Lifecycle events.** The following events are emitted through the [Webhooks](./webhooks.md) module so callers do not need to poll:

| Event                                | When                                          |
| ------------------------------------ | --------------------------------------------- |
| `orchestration_runs.started`         | A run is created and begins executing         |
| `orchestration_runs.awaiting_input`  | A run pauses on a `human`/`webhook` node      |
| `orchestration_runs.succeeded`       | A run reaches `succeeded`                      |
| `orchestration_runs.failed`          | A run reaches `failed`                        |

The scheduler tick — which both wakes due `sleeping` runs and reaps orphaned `running` runs — is configurable:

| Environment Variable | Required | Description |
| --- | --- | --- |
| `ORCHESTRATION_SCHEDULER_INTERVAL_MS` | No | Scheduler tick interval in ms (default `5000`). |
| `ORCHESTRATION_RUN_LEASE_TTL_MS` | No | How long a `running` run's lease is valid before the reaper may reclaim it, in ms (default `600000`). Must exceed the longest single round of node execution. |

### State and Mappings

Each node can define:

- **`input_mapping`** — Maps node input keys to values resolved against the run state before execution. Each value is [JSON Logic](https://jsonlogic.com) (see [Input Mapping](#input-mapping-json-logic)).
- **`state_mapping`** — Projects a node's artifact into state after execution. Each **key** is a state write path and should start with the literal `state.` prefix (e.g. `"state.summary"`); a key without the prefix (e.g. `"summary"`) is normalized to be state-relative, the same convention `loop.collection` already uses. Each **value** is [JSON Logic](https://jsonlogic.com) evaluated against `{ "output": <the node's artifact>, "state": <run state> }` — the same evaluator as `input_mapping`/`transform`/`condition`, just a different context. `{ "summary": { "var": "output.content" } }` writes the artifact's `content` field to `state.summary`; a literal value (string, number, boolean) is written as-is. A **dotted** target such as `"state.proposed.action_id"` builds a nested object (`state.proposed = { action_id: … }`), so a later node reads it back with `{"var": "proposed.action_id"}` — the `var` reader descends dot-paths.

  ```json
  { "id": "summarise", "type": "agent", "agent_id": "agent_xyz", "state_mapping": { "state.summary": { "var": "output.content" } } }
  ```

  Since it is JSON Logic, `state_mapping` can also compute derived values or read the artifact's own upstream state — e.g. `{ "state.count": { "+": [{ "var": "state.count" }, { "var": "output.delta" }] } }` accumulates a running total across nodes.

#### The `nodes.<id>` namespace

Every completed node's full artifact is also recorded at `state.nodes.<nodeId>`, whether or not the node declares a `state_mapping` — giving orchestrations the same read-any-upstream-result ergonomics as a pipeline's `steps.<id>` (see [Pipeline Tools](./tools.md#pipeline)). A downstream node reads it with `{ "var": "nodes.<nodeId>.<field>" }` without any explicit wiring on the upstream node:

```json
[
  { "id": "fetch", "type": "tool", "tool_id": "tool_abc" },
  {
    "id": "summarise",
    "type": "agent",
    "agent_id": "agent_xyz",
    "input_mapping": { "prompt": { "var": "nodes.fetch.result" } }
  }
]
```

`nodes` is a reserved top-level state key: the engine owns it exclusively, so [static validation](#static-validation) rejects a `state_mapping` write targeting it, and a `{ "var": "nodes.<id>..." }` reference is checked the same way a `state_mapping`-declared key is — `<id>` must name an earlier (upstream) node in the graph. (An `input_schema` property named `nodes` is allowed: run input is seeded under `state.input`, so it cannot collide.) A `condition` node completes with a label rather than an artifact; its namespace entry is `{ "label": "<emitted label>" }`, readable as `{ "var": "nodes.<id>.label" }`.

#### Evaluation scope

Every JSON Logic expression in a graph is evaluated against the run **state**, which is the single shared context: it holds the run input (see [Run input](#run-input)) plus everything upstream nodes have written via `state_mapping`, plus every upstream node's raw artifact under `nodes.<id>`. What differs between node types is not the scope but what each node *does* with it:

- **`transform` and `condition`** evaluate their `expression` against the full state directly.
- **`agent`, `tool`, `knowledge`, `memory_write`, `human`, `webhook`, `sub_orchestration`** evaluate each `input_mapping` value against the full state and pass only that projected result to the node (an agent's prompt, a tool's input, etc.) — they do not receive the whole state.
- **`poll`** evaluates its `input_mapping` against state, then its `exit_condition` against state augmented with `response` (the latest tool result) and `attempt` (see [Polling](#polling)).

#### Input Mapping (JSON Logic)

Each `input_mapping` value is evaluated as [JSON Logic](https://jsonlogic.com) against the run state — the same evaluator used by `transform` and `condition` nodes. This gives one expression language across the whole platform: pass literals, read state, or compute derived values inline, without a dedicated `transform` node.

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

#### Run input

Values passed to [`start-orchestration-run`](#examples) via `input` seed the initial state under an `input` namespace, read with `{"var": "input.key"}` — matching the pipeline/formation convention, so run input, pipeline `input.*`, and formation `${...}` all read the same way.

Input keys round-trip **verbatim** (they are not case-transformed), so a key sent as `cycle_task` is read as `{"var": "input.cycle_task"}` — not `{"var": "input.cycleTask"}`. Because the `input` namespace is always seeded, a `{"var": "input.<name>"}` reference in an `input_mapping` satisfies [static validation](#static-validation) regardless of the declared `input_schema`; a **flat** `{"var": "<name>"}` reference is never satisfied by run input (only by an upstream node's own `state_mapping` write) — earlier releases also seeded run input flat across top-level state keys, but that alias has been removed.

To pass a literal object that happens to look like a JSON Logic expression — e.g. the JSON Logic object `{"var": "x"}` itself, as data rather than an expression to evaluate — wrap it in `preserve`, which returns its argument unevaluated: `{"preserve": {"var": "x"}}`.

> **Note:** an `input_mapping` bare string is a literal value; use `{"var": "key"}` to read `state.key`. (Earlier releases treated a bare `state.<key>` string as a state path — migrate those to `{"var": "key"}`.)

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
| Unsatisfiable `input_mapping` reference | a `{"var": "x"}` whose `state.x` is never written by an upstream node, in a graph that declares an `input_schema` — declaring `x` in the schema does not help, since run input is only readable as `{"var": "input.x"}` |
| Unsatisfiable `nodes.<id>` reference | a `{"var": "nodes.ghost..."}` where `ghost` is not an earlier (upstream) node in the graph — checked regardless of `input_schema`, since `nodes` is never part of run input |
| Reserved `nodes` namespace write | a `state_mapping` key (e.g. `"state.nodes.x"`) targets the engine-owned `nodes` state key |

**Warnings (never block):**

| Check | Example |
| ----- | ------- |
| Conditional-branch state read | a node reads `{"var": "branch"}` that an upstream node writes only on one side of a `condition`, so it may be undefined when the node runs |

The `input_mapping` reachability check only treats an unwritten reference as an **error** when an `input_schema` is declared (a closed input contract). Without an `input_schema` the graph stays permissive — a parallel (non-upstream) node's `state_mapping` may legitimately write the key before the reader runs. The check walks the graph's edges to determine which nodes are upstream, and uses dominator analysis to distinguish a key that is guaranteed-written from one written only on a conditional branch. A `{"var": "nodes.<id>..."}` reference is the one exception: since `nodes.<id>` is written exclusively by the referenced node completing, an unwritten reference is always an error, open contract or not.

```bash
soat validate-orchestration \
  --nodes '[{"id":"a","type":"transform","expression":1,"state_mapping": { "state.step1": { "var": "output.result" } }},
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
  "error": { "code": "ORCHESTRATION_NODE_FAILED", "message": "Agent 'agent_x' not found." },
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
      "error": { "code": "ORCHESTRATION_NODE_FAILED", "message": "Agent 'agent_x' not found." }
    }
  ]
}
```

Records are returned by both `get-orchestration-run` and `list-orchestration-runs`, ordered oldest-first. A node that pauses the run for human input is recorded with `status: "requires_action"`; once `submit-human-input` (or `resume-orchestration-run`) satisfies the pause, that same record is updated to `status: "completed"` with `output` set to the submitted payload and `completed_at` set to the resume time — it is never left behind as `requires_action` in a finished run. A node that was never reached is recorded with `status: "skipped"` once the run completes. For a worked example of reading back the accumulated state and per-node output of a finished run, see [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state).

### Run usage

Every generation an `agent` node dispatches meters against the run: its [usage](./usage.md) event carries the run's `run_id` and the dispatching `node_id`. `get-orchestration-run` surfaces the roll-up inline as a `usage` object (`total_input_tokens`, `total_output_tokens`, `total_cached_tokens`, `total_reasoning_tokens`, `total_cost_usd`) summed across the run's generations — "one operating cycle → one action" cost, without a second request. For the full per-event breakdown (line items, price rows, `by_meter_type` split), fetch the run receipt at `GET /api/v1/usage/receipt?run_id=…` — see [Receipts](./usage.md#receipts-and-reconciliation).

When a run is started by a [trigger](./triggers.md), the trigger id is propagated onto every in-run generation's usage event, so run spend also rolls up per trigger via the [usage](./usage.md) event list (`?trigger_id=`).

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

### Approval Nodes

An `approval` node proposes a guarded tool call and pauses the run for a human decision. Unlike a `human` node — which is resumed directly via `human-input` — an approval node files an [ApprovalItem](./approvals.md) at emit time and is resumed **only** by resolving that item through the [Approvals](./approvals.md) queue (`POST /approvals/{id}/approve` or `/reject`), or by server-side expiry.

The run pauses with `required_action.type: "approval"`, carrying the created item:

```json
{
  "required_action": {
    "type": "approval",
    "node_id": "gate",
    "approval_id": "apr_x1y2z3a4b5c6d7e8",
    "expires_at": "2026-07-15T16:00:00.000Z"
  }
}
```

The node's `arguments`, `reasoning`, `evidence`, and `predicted_impact` mappings are resolved against run state and **frozen** onto the item at emit time. On resolution the decision (`approved` | `rejected` | `expired`) becomes the node's branch label:

- Edges labeled `condition: "approved"` / `"rejected"` / `"expired"` route by the decision — the counterpart of a `condition` node's labels.
- An **unlabeled** edge leaving an approval node follows **only on approval**; the rejection and expiry paths must be modeled with explicit labeled edges. If no edge matches a `rejected`/`expired` decision, the run ends at the node.

Expiry is enforced server-side (see [Approvals — Expiry is a hard gate](./approvals.md#expiry-is-a-hard-gate)): an expired item can never execute, and the run routes down its `expired` edge.

### Common Errors

| Code                              | Status | Cause                                                                                       | What to do                                                                                                 |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ORCHESTRATION_VALIDATION_FAILED`  | `400`  | `create-orchestration`/`update-orchestration` rejected an invalid graph                       | Read `error.meta.errors`, or call `validate-orchestration` first — see [Static Validation](#static-validation) |
| `ORCHESTRATION_CYCLE_DETECTED`     | —      | A cycle reached execution (graphs with a cycle are normally rejected at validation time)      | Remove the cycle, or use a `loop` node if the repetition is intentional — see [Cycle Detection](#cycle-detection) |
| `ORCHESTRATION_NODE_FAILED`        | `422`  | A node threw during execution (e.g. a referenced `agent_id`/`tool_id` no longer exists)       | Inspect the failing node's entry in `node_executions` for the exact `error` — see [Node Executions](#node-executions) |
| `ORCHESTRATION_POLL_EXHAUSTED`     | —      | A `poll` node's `max_iterations` was reached with `failOnTimeout: true`                       | Raise `max_iterations`/`interval`, or handle `conditionMet: false` downstream instead of setting `failOnTimeout` — see [Polling](#polling) |

**Debugging a failed run beyond "check the trace":** call `get-orchestration-run` and read `node_executions` — each entry has `node_id`, the resolved `input` the node received, and (on failure) the structured `error`, so you can see exactly which node failed, with what input, and why, without reconstructing state from the trace alone. See [Node Executions](#node-executions).

**A run appears stuck in a non-terminal state:**

- `sleeping` — the run is parked on a `delay`/`poll` wait or a node's retry backoff and holds no worker; it resumes on its own once `active_nodes[].wake_at` (or the node's backoff delay) elapses. This is expected, not stuck — see [Durable Background Execution](#durable-background-execution).
- `awaiting_input` — the run is parked on a `human` node or a `webhook (mode: receive)` node; it stays there until `submit-human-input` (or `resume-orchestration-run`) is called with the paused node's `node_id` — see [Human Nodes](#human-nodes).
- `running` for far longer than expected — the process driving it may have crashed or been redeployed mid-execution. The background reaper reclaims any run whose lease (`lease_expires_at`) has expired and resumes it from the last checkpoint; a healthy run refreshes its lease every round, so this self-heals within `ORCHESTRATION_RUN_LEASE_TTL_MS` without intervention — see [Durable Background Execution](#durable-background-execution).

## Examples

### Create a sequential pipeline

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "fetch-and-summarize" \
  --nodes '[
    {"id":"fetch","type":"tool","tool_id":"tool_abc","state_mapping": { "state.raw": { "var": "output.result" } }},
    {"id":"summarise","type":"agent","agent_id":"agent_xyz","input_mapping":{"prompt":{"var":"raw"}},"state_mapping": { "state.summary": { "var": "output.content" } }}
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
        state_mapping: { 'state.raw': { var: 'output.result' } },
      },
      {
        id: 'summarise',
        type: 'agent',
        agent_id: 'agent_xyz',
        input_mapping: { prompt: { var: 'raw' } },
        state_mapping: { 'state.summary': { var: 'output.content' } },
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
        "state_mapping": { "state.raw": { "var": "output.result" } }
      },
      {
        "id": "summarise",
        "type": "agent",
        "agent_id": "agent_xyz",
        "input_mapping": {"prompt": {"var": "raw"}},
        "state_mapping": { "state.summary": { "var": "output.content" } }
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
    { "id": "branch_a", "type": "agent", "agent_id": "agent_a", "state_mapping": { "state.a": { "var": "output.content" } } },
    { "id": "branch_b", "type": "agent", "agent_id": "agent_b", "state_mapping": { "state.b": { "var": "output.content" } } }
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
    { "id": "high_path", "type": "agent", "agent_id": "agent_high" },
    { "id": "low_path", "type": "agent", "agent_id": "agent_low" }
  ],
  "edges": [
    { "from": "check", "to": "high_path", "condition": "high" },
    { "from": "check", "to": "low_path", "condition": "low" }
  ]
}
```

### Agent Squad

A team of agents plus the flow that coordinates them can deploy as a single [Formation](./formations.md) stack, because an orchestration is itself a formation resource type. A node's `agent_id` uses a [`ref` expression](./formations.md#ref-expressions) to bind to an agent created in the same template; SOAT resolves it to the physical `agent_...` ID before the orchestration is created. Node fields are written in snake_case (`agent_id`, `input_mapping`, `state_mapping`), exactly as in this module's REST contract. For a full step-by-step build, see [Create an Agent Squad](/docs/tutorials/create-an-agent-squad).

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
            "state_mapping": { "state.draft": { "var": "output.content" } }
          },
          {
            "id": "review",
            "type": "agent",
            "agent_id": { "ref": "Reviewer" },
            "input_mapping": { "prompt": { "var": "draft" } },
            "state_mapping": { "state.final": { "var": "output.content" } }
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
            state_mapping: { 'state.draft': { var: 'output.content' } },
          },
          {
            id: 'review',
            type: 'agent',
            agent_id: { ref: 'Reviewer' },
            input_mapping: { prompt: { var: 'draft' } },
            state_mapping: { 'state.final': { var: 'output.content' } },
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
