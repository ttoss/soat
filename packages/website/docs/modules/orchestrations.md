---
description: "DAG-based pipeline definitions that chain agents, tools, and knowledge lookups into repeatable pipelines."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestrations

DAG-based pipeline definitions for chaining agents, tools, and knowledge lookups into repeatable pipelines.

## Overview

Orchestrations describe a directed acyclic graph (DAG) of nodes where each node performs a discrete operation. Nodes in the same execution round run in parallel; edges with activation groups control fan-in convergence. Use an orchestration when you know the exact steps in advance and want deterministic, auditable execution — an `agent` node can still use LLM reasoning internally, but the graph itself is deterministic. See it end to end in [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph).

An orchestration is a pipeline that _ends_; a [workflow](./workflows.md) is a state graph a task _lives_ in. See [Choosing an Automation Model](/docs/advanced/choosing-an-automation-model) for the comparison and composition patterns — starting with [whether the work needs a graph at all](/docs/advanced/choosing-an-automation-model#step-0--you-may-need-neither), since an orchestration is the [graph layer](/docs/agent-system-layers) and the graph is the layer to build last. An orchestration can also be declared as a [Formation](./formations.md) resource — see [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — and can be run automatically by binding it to a [Trigger](./triggers.md) with `target_type: orchestration`.

> See the [Permissions Reference](../permissions.md#orchestrations) for the IAM action strings for this module.

## Related Tutorials

- [Orchestration Control Flow: Delay, Poll, and Loop](/docs/tutorials/orchestration-control-flow) — the `delay`, `poll`, `loop`, and `condition` nodes in one deterministic run, with a reference table for every node type
- [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration) — condition nodes, branch routing, and `skipped` node executions
- [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph)
- [Orchestrate a Sonnet - Step 7 (Start a run)](/docs/tutorials/orchestrate-a-sonnet#step-7--start-a-run)
- [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state)
- [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — a team of agents plus a coordinating orchestration, deployed and run as one stack
- [Close the Monthly Books - Step 4 (Validate and create the reconciliation graph)](/docs/tutorials/close-the-monthly-books#step-4--validate-and-create-the-reconciliation-graph) — parallel start nodes, an `activation_group` join, and a branch decided by arithmetic rather than a model

## Data Model

### Orchestration

| Field          | Type           | Description                                      |
| -------------- | -------------- | ------------------------------------------------ |
| `id`           | string         | Public ID (`orch_` prefix)                       |
| `project_id`   | string         | Owning project                                   |
| `name`         | string         | Human-readable name                              |
| `description`  | string \| null | Optional description                             |
| `version`      | integer        | Incremented on every write that changes the graph; prior versions are archived (see [Versioning](#versioning)) |
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
| `orchestration_version` | integer \| null | The orchestration version this run executes, fixed when the run started (see [Versioning](#versioning)). `null` for runs created before pinning existed, which execute the live graph |
| `project_id`       | string         | Owning project                                                    |
| `status`           | string         | `queued` \| `running` \| `sleeping` \| `awaiting_input` \| `succeeded` \| `failed` \| `cancelled` \| `expired` |
| `state`            | object         | Current mutable execution state                                   |
| `active_nodes`     | array          | Node IDs awaiting input or a scheduled wake (populated when `awaiting_input`, or `sleeping` while parked on a `delay`/`poll` wait) |
| `artifacts`        | object         | Outputs keyed by node ID                                          |
| `error`            | object \| null | Error details if failed                                           |
| `node_executions`  | array          | Per-node execution records (see [Node Executions](#node-executions)) |
| `usage`            | object         | What the run cost: token/cost roll-up (`total_input_tokens`, `total_output_tokens`, `total_cached_tokens`, `total_reasoning_tokens`, `total_cost_usd`) summed across this run's generations **and every run it started** through `loop` / `sub_orchestration` nodes, at any depth (see [Run usage](#run-usage)). Present on the single-run read; omitted from run list responses |
| `usage_own`        | object         | The same roll-up restricted to **this run's own nodes**, excluding nested runs. Equal to `usage` for a run with no children. Present on the single-run read; omitted from run list responses |
| `required_action`  | object \| null | Present when status is `awaiting_input` (see [Human Nodes](#human-nodes)) |
| `trace_id`         | string \| null | Linked observability trace, if any                                |
| `input`            | object \| null | Initial input provided at run creation                            |
| `tool_context`     | object \| null | Caller context forwarded as `X-Soat-Context-*` headers on the tool calls of the run — every `agent` node's generation, and every `tool` / `poll` node's call (see [Run Tool Context](#run-tool-context)) |
| `metadata`         | object \| null | Caller-owned annotations supplied at run creation and returned verbatim; never merged into `state` (see [Run Metadata](#run-metadata)) |
| `output`           | object \| null | Terminal node artifact(s) when the run has `succeeded`            |
| `parent_orchestration_run_id` | string \| null | The run whose node started this one — set only on a `loop` / `sub_orchestration` child, null for a run a caller started |
| `parent_node_id`   | string \| null | The node within `parent_orchestration_run_id` that started this run |
| `started_at`       | string \| null | ISO 8601 execution start timestamp                                |
| `completed_at`     | string \| null | ISO 8601 terminal timestamp (`succeeded`/`failed`/`cancelled`/`expired`) |
| `created_at`       | string         | ISO 8601 creation timestamp                                       |
| `updated_at`       | string         | ISO 8601 last-updated timestamp                                   |

### NodeExecution

Each entry in a run's `node_executions` array records a single node execution, in chronological order.

| Field          | Type           | Description                                              |
| -------------- | -------------- | -------------------------------------------------------- |
| `node_id`      | string         | ID of the executed node                                  |
| `node_type`    | string \| null | Node type (`agent`, `transform`, …)                      |
| `attempt`      | integer        | 1-based attempt number (a retried node yields one record per attempt) |
| `status`       | string         | `running` \| `completed` \| `failed` \| `requires_action` \| `skipped` (`running` is the transient pre-completion state of a side-effecting node) |
| `input`        | object \| null | Resolved `input_mapping` the node received               |
| `output`       | object \| null | Output artifact the node produced (`null` when failed)   |
| `error`        | object \| null | `{ code, message }` when `status` is `failed`            |
| `started_at`   | string \| null | ISO 8601 timestamp when the node began executing         |
| `completed_at` | string \| null | ISO 8601 timestamp when the record was written           |
| `created_at`   | string         | ISO 8601 creation timestamp                              |

A node execution records the node's **external I/O** — the input it resolved and the artifact it returned — not the model's internal reasoning, and it carries **no generation id**. To reach what an `agent` node's model actually did, see [Reaching an agent node's generation](#reaching-an-agent-nodes-generation).

## Key Concepts

### Node Types

| Type           | Description                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent`        | Invokes a SOAT [Agent](./agents.md) with a prompt. Uses `agent_id` and `prompt`.                                                    |
| `tool`         | Calls a SOAT [Tool](./tools.md). Uses `tool_id` and `input_mapping`. Its artifact is the tool's own result object — see [Node artifacts](#node-artifacts). Gated by [Guardrails](./guardrails.md) at dispatch — see [Guardrail interception](#guardrail-interception-on-tool-nodes).                     |
| `transform`    | Evaluates a [JSON Logic](https://jsonlogic.com) rule against the current state. Uses `expression`.                                  |
| `knowledge`    | Searches a knowledge source via the [Knowledge](./knowledge.md) module. Uses `input_mapping` with `query` and optional `memory_ids`. |
| `memory_write` | Writes a [Memory](./memories.md) entry. Uses `memory_id` and `input_mapping` with `content`.                                        |
| `condition`    | Evaluates a JSON Logic rule and emits a string label. Downstream edges use `condition: "<label>"` to select the active branch.      |
| `human`        | Pauses the run and waits for external input. The run enters `awaiting_input` status with `required_action`.                         |
| `approval`     | Proposes a guarded tool call and pauses for a human decision via the [Approvals](./approvals.md) queue. Uses `tool_id`, `arguments`, and `expires_in`. See [Approval Nodes](#approval-nodes).                         |
| `loop`         | Iterates a state collection, running a sub-orchestration per item. Uses `orchestration_id`, `collection`, `item_variable`, and `parallelism`. See [Loops](#loops-collection-iteration). |
| `poll`         | Calls a tool on an interval until a JSON Logic exit condition on the response holds. Uses `tool_id`, `exit_condition`, and `interval`. See [Polling](#polling). |
| `delay`        | Waits for a fixed `duration`, then continues. Accepts `5s`/`5m`/`2h`/`500ms` or ISO 8601 (`PT5S`).                                   |
| `emit_event`   | Emits an internal event of type `event_type` carrying the `input_mapping` result as the event `data`. See [Emitting events](#emitting-events). |
| `webhook`      | Pauses awaiting an inbound callback (`mode: "receive"`). The run enters `awaiting_input` with `required_action.type: "webhook_receive"`; resume it via `human-input`. (To send data _out_ of a graph, use `emit_event`.) |
| `sub_orchestration` | Runs another orchestration as a single step. Uses `orchestration_id`. The node's artifact is the **child run's `output`** — `{ terminalNodeId: terminalArtifact }`, not a flattened value. `state_mapping` values are JSON Logic, whose `var` reader descends dot-paths, so `{"var": "output.terminalNodeId.someField"}` pulls a deep field directly. |

### Node artifacts

Every completed node produces an **artifact** — the object that `state_mapping` reads as `output` and that downstream nodes read as [`nodes.<id>`](#the-nodesid-namespace). The shape is per node type:

| Type | Artifact |
| ---- | -------- |
| `agent` | `{ content }`. With an `output_schema`, the artifact becomes **that object** instead — see [Agent node output_schema](#agent-node-output_schema). |
| `tool` | **The tool's result object itself**, not a wrapper — a tool returning `{"status":"ok"}` yields `{"status":"ok"}`, read as `{"var": "output.status"}`. Only a **non-object** result (string, number) is wrapped as `{ result }`. A guardrail-blocked call yields `{ status: "blocked", reason }` instead — see [Guardrail interception](#guardrail-interception-on-tool-nodes). |
| `transform` | `{ result }` — the evaluated `expression`. |
| `condition` | No artifact; the node emits a branch label. Its namespace entry is `{ label }`, read as `{"var": "nodes.<id>.label"}`. |
| `knowledge` | `{ results }` — the matched entries. |
| `memory_write` | `{ action }` — e.g. `"created"`. |
| `human`, `webhook` (`mode: "receive"`) | The payload submitted to `submit-human-input`, verbatim. |
| `approval` | `{ decision, approvalId, resolvedBy, reason, result, editedArgs }` — see [Approval Nodes](#approval-nodes). |
| `loop` | `{ results }` — one entry per item, each the sub-run's `output`. See [Loops](#loops-collection-iteration). |
| `poll` | `{ result, attempts, conditionMet, timedOut }`. See [Polling](#polling). |
| `delay` | `{ waited }` — the `duration` as declared. |
| `emit_event` | `{ emitted, eventType }`. See [Emitting events](#emitting-events). |
| `sub_orchestration` | The child run's `output`, i.e. `{ terminalNodeId: terminalArtifact }`. |

The common trap is `tool`: because the artifact is the tool's result verbatim, `{"var": "output.result"}` resolves to `null` for any tool returning a JSON object. Map the field the tool actually returns.

#### Agent node `output_schema`

When an `agent` node declares an `output_schema`, the engine resolves the artifact in order: (1) the model provider's own structured output, when the agent's configured `output_schema` reaches it as a generation-time constraint (see [Agents](./agents.md)); (2) otherwise, the raw text response parsed as JSON, stripping a single markdown code fence first; (3) if neither produces a JSON object, the artifact falls back to `{ content }` and the node still completes — a mismatch never fails the run (a `soat:orchestrations` debug log records the parse failure).

`output_schema` is a **best-effort parsing aid**, not a hard validation gate: a parsed object is accepted whether or not its fields satisfy the schema, and a node-level `output_schema` that differs from its agent's own is not forwarded to the model.

> **Tip:** a `state_mapping` that writes `null` usually means the mapping read a field the artifact does not have. Every artifact is visible under `state.nodes.<id>` in `get-orchestration-run`, so check there for the real shape.

### Guardrail interception on tool nodes

A `tool` node's call is classified by [Guardrails](./guardrails.md) at dispatch. With no agent in scope the node composes the **project + tool** scopes only; the strictest [action class](./guardrails.md#action-classes) is enacted in graph terms:

- **A / passing B** — the tool runs with the (cleaned) `input_mapping` result.
- **C (human sign-off)** — the run parks on the node (`required_action.type: "approval"`) and files an [ApprovalItem](./approvals.md) with the frozen arguments, exactly like an [approval node](#approval-nodes). On approval the node re-dispatches the tool and continues down its success edge; on rejection/expiry the tool never runs and only a matching `condition: "rejected"` / `"expired"` edge follows.
- **D / tripwire** — a routable **`blocked`** outcome: the node records a `{ status, reason }` artifact and emits a `blocked` (or `tripwire`) branch label, so an edge with `condition: "blocked"` routes to a fallback. An **unlabeled** success edge does not follow a blocked node.

Guardrails attach to the referenced [tool](./tools.md) (or the run's project) via `guardrail_ids`; there is no per-node guardrail field.

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

A `poll` node repeatedly calls a [Tool](./tools.md) until a [JSON Logic](https://jsonlogic.com) **exit condition** on its response is satisfied. Each attempt calls `toolId` (resolving `inputMapping` against state, like a `tool` node), then evaluates `exitCondition` against the run state augmented with `response` (the latest tool result) and `attempt` (1-based count). A truthy result stops polling; otherwise the run is parked and the background scheduler drives the next attempt after `interval`, bounded by `maxIterations` (default 10, ceiling 1000). There is no wall-clock ceiling — the wait holds no HTTP request open, so a poll can span hours or days.

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

> **Note:** `poll` and `delay` waits are offloaded to the background scheduler (see [Durable Background Execution](#durable-background-execution)); a run parked on a wait survives a server restart.

### Emitting events

An `emit_event` node emits an **internal event** — it calls no URL itself. Delivery is entirely the [Webhooks](./webhooks.md) module's job: any webhook subscribed to the event type in the run's project delivers it — signed, retried, tracked, and policy-gated — so the graph holds **no URL and no secret**.

- **`event_type`** — the event type to emit, e.g. `guardrail.exception`. A subscriber listens with `create-webhook --events "guardrail.exception"` (or a pattern like `guardrail.*`).
- **`input_mapping`** — resolved against run state to build the event `data` payload.

The node is fire-and-forget: it completes as soon as the event is emitted, and the run neither blocks on nor fails from any subscriber's delivery outcome. Its artifact is `{ emitted: true, eventType: "<type>" }`. (If a graph needs a _synchronous_ call whose failure must fail the run, use an `http` [tool](./tools.md) node instead.)

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

Any node can declare a `retry` policy. When the node throws a **transient** error and attempts remain, the run parks as `sleeping` and re-executes the node after a backoff delay (offloaded to the scheduler, so retries survive a restart and hold no worker). Absent, or `max_attempts <= 1`, is fail-fast.

Unexpected/infrastructure errors (network, timeouts, provider SDK throws) and upstream `5xx` errors are **retriable**; deliberate `4xx` business errors (validation, not found, conflict) are **terminal** and fail the run immediately without consuming attempts. Each attempt writes its own `node_executions` record with an incrementing `attempt`.

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

> **Note:** a **retry** (a new attempt) is deliberately not deduped; a **redelivery** of the same attempt is — see [Idempotency](#idempotency-of-node-execution).

### Durable Background Execution

Runs execute in a **queue-backed durable worker**, detached from the HTTP request that starts them:

- `start-orchestration-run` persists the run, enqueues a `continue` task, and returns immediately with `status: "queued"` — no node executes inside the request. Observe progress with `get-orchestration-run` or via run lifecycle [webhook](./webhooks.md) events. (The single-process default runs the worker loop inside the API process, so the run starts draining right away.)
- `delay` and `poll` waits park the run as **`sleeping`** — pure DB state, no worker, no memory. The wake time is persisted and the scheduler enqueues a `wake` task when due, so a run containing `delay: "2h"` survives a restart and completes on schedule.
- `human` and `webhook (mode: receive)` nodes park the run as **`awaiting_input`**; satisfy the pause with `submit-human-input`, which applies the submitted payload, drives the run inline, and returns the settled result. `resume-orchestration-run` only re-drives an `awaiting_input` run from its last checkpoint — it carries no `node_id` or payload, so it cannot satisfy a pause and will simply re-park on the same node.

**Run identity.** A run outlives the request that started it. Each run persists the principal that started it (the user or API key), and every background drive re-mints a short-lived **run-as token** from it, confined to the run's project — this is what lets a [`builtin` tool](./tools.md#builtin) node call the platform from a durable run.

- **Identity only, not permissions.** Authorization is evaluated per call against policies as they stand at that moment, so revoking access takes effect on a run already in flight.
- **Never wider than the starting credential.** A run started by an API key is bounded by that key's own policies; revoke the key and the run stops acting rather than falling back to its owner's access.
- **Attributed to the key, not its owner.** A key-started run names the key (`key_…`) in [task history](./workflows.md#transition-history), the [audit log](./audit-log.md), and the principal a later automation hop inherits.
- **Trigger- and OAuth-started runs record no principal.** Their boundary lives in the token (the trigger's attached policy, the consented scope), so they execute inline with the original token. A run with no principal still runs — only its platform self-calls are unauthenticated, and they fail loudly (`TOOL_HTTP_ERROR` carrying the upstream 401).

Nested `loop` and `sub_orchestration` children inherit their parent's identity, so a whole tree of runs acts as one principal. The same mechanism covers a [workflow](./workflows.md)-dispatched agent, keyed to the task rather than a run.

**Queue driver.** The queue is reached through a four-operation abstraction (`enqueue` / `claim` / `ack` / `retry`), selected with `ORCHESTRATION_QUEUE_DRIVER`. Both drivers give at-least-once delivery with lease-based redelivery:

| | `postgres` (default) | `sqs` |
| --- | --- | --- |
| Backing store | `orchestration_run_tasks` table (`SELECT … FOR UPDATE SKIP LOCKED` + lease) | an SQS queue (visibility timeout **is** the lease) |
| Per-project `max_concurrent_runs` | **enforced** at claim time | **not enforced** |
| `oldest_queued_age_seconds`, `per_project` stats | reported | `null` / empty |

Postgres needs no infrastructure beyond the database. Choose `sqs` when a deployment standardizes on a managed queue and accepts the two differences above. A backoff longer than SQS's 15-minute maximum delay becomes 15 minutes — the run's persisted `wake_at` still decides whether there is anything to do. An unrecognized `ORCHESTRATION_QUEUE_DRIVER`, or `sqs` without a queue URL, fails loudly (`QUEUE_DRIVER_MISCONFIGURED`) rather than silently falling back to Postgres.

**Separate worker process.** The worker loop runs inside the API process by default. `node dist/worker.js` starts only the scheduler tick + worker loop — no HTTP listener — so the queue can be drained by a dedicated worker with the API tier running request-only (`ORCHESTRATION_WORKER_DISABLED=true`). On `SIGTERM`/`SIGINT` the worker stops claiming new tasks and finishes claimed ones before exiting; unfinished tasks are left un-acked and redelivered. A standalone worker publishes a heartbeat file after every **successful** queue claim (`ORCHESTRATION_WORKER_HEARTBEAT_FILE`), and `workerHealthcheck.mjs` exits `0` only while that heartbeat is younger than `ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS` — a worker that can no longer reach the queue goes unhealthy instead of looking alive.

**Crash recovery.** While a run is `running` it holds a **lease** (`lease_expires_at`), refreshed after every completed round. A background reaper reclaims runs whose lease has expired and enqueues a `continue` task so a worker re-drives them from the last checkpoint — completed nodes are skipped and only the unfinished frontier re-executes.

**Synchronous (compatibility) mode.** Pass `wait: true` to `start-orchestration-run` to block until the run reaches a terminal (`succeeded`/`failed`) or `awaiting_input` state. Nested `loop` and `sub_orchestration` runs always execute synchronously so their output can be aggregated. See [Synchronous vs Asynchronous Execution](../advanced/sync-and-async.md) for the platform-wide contract.

**Lifecycle events** emitted through the [Webhooks](./webhooks.md) module: `orchestration_runs.started`, `orchestration_runs.awaiting_input`, `orchestration_runs.succeeded`, `orchestration_runs.failed`.

#### Idempotency of node execution

At-least-once delivery means a node executor must tolerate replay. Each **side-effecting** node execution (`agent`, `tool`, `memory_write`, `emit_event`, `sub_orchestration`, `loop`) is written with a run-scoped idempotency key `{orchestration_run_id}:{node_id}:{attempt}`, inserted `running` **before** the side effect runs and updated in place afterward. A **redelivery** of the same `(run, node, attempt)` finds the key `completed` and reuses the stored output; a **retry** (a new attempt) is a new key and runs for real.

The honest boundary: a worker that crashes *between* firing the side effect and marking the key `completed` leaves a `running` key; the redelivering worker re-executes under the same key. To let downstream services dedupe that window, an `http` tool node forwards its key verbatim as an **`Idempotency-Key`** request header. Pure nodes (`condition`, `transform`, `delay`, `human`, `approval`, `webhook`) are unkeyed.

### Concurrency limits

Parallelism is bounded on two axes:

- **Per project.** A project's [`max_concurrent_runs`](./projects.md) caps how many of its runs may be actively driven at once, enforced at queue **claim time**: excess tasks stay `queued` (never failed) until a slot frees. `null` (the default) means unlimited. Only actively-driven runs occupy a slot — a run parked `sleeping` or `awaiting_input` holds no task and no slot, and a run never blocks on itself. Enforced by the **Postgres** driver only.
- **Global (per worker).** `ORCHESTRATION_WORKER_CONCURRENCY` caps the tasks a single worker process holds claimed-and-unacked at any instant; `ORCHESTRATION_WORKER_BATCH` is the per-tick claim size beneath it, so the effective claim each tick is `min(BATCH, CONCURRENCY − in-flight)`. A fleet of P workers bounds global parallelism at `P × CONCURRENCY`.

### Queue metrics

[`GET /api/v1/orchestrations/queue/stats`](/docs/api/orchestrations/get-queue-stats) returns a point-in-time snapshot of the run queue — waiting vs. claimed task counts, the oldest waiting task's age, recent claim-latency percentiles (computed in-process over a rolling 5-minute window), and a per-project breakdown. `driver` names the active backend; under `sqs`, `oldest_queued_age_seconds` / `per_project` are `null` / empty. Guarded by the `orchestrations:GetQueueStats` action; a project-scoped caller sees only their own projects under `per_project`.

### State and Mappings

Each node can define:

- **`input_mapping`** — Maps node input keys to values resolved against the run state before execution. Each value is [JSON Logic](https://jsonlogic.com) (see [Input Mapping](#input-mapping-json-logic)).
- **`state_mapping`** — Projects a node's artifact into state after execution. Each **key** is a state write path and should start with the literal `state.` prefix (a key without the prefix is normalized to be state-relative). Each **value** is JSON Logic evaluated against `{ "output": <the node's artifact>, "state": <run state> }` — the same evaluator as `input_mapping`/`transform`/`condition`. A literal value is written as-is; a **dotted** target such as `"state.proposed.action_id"` builds a nested object, read back with `{"var": "proposed.action_id"}`. Since it is JSON Logic, `state_mapping` can also compute derived values — e.g. `{ "state.count": { "+": [{ "var": "state.count" }, { "var": "output.delta" }] } }` accumulates a running total.

  ```json
  { "id": "summarise", "type": "agent", "agent_id": "agent_xyz", "state_mapping": { "state.summary": { "var": "output.content" } } }
  ```

Every JSON Logic expression in a graph is evaluated against the run **state** — the run input (see [Run input](#run-input)), everything upstream nodes wrote via `state_mapping`, and every upstream node's raw artifact under `nodes.<id>`. `transform` and `condition` evaluate their `expression` against the full state; other node types receive only their projected `input_mapping` result; `poll` additionally evaluates its `exit_condition` against state augmented with `response` and `attempt`.

#### The `nodes.<id>` namespace

Every completed node's full artifact is also recorded at `state.nodes.<nodeId>`, whether or not the node declares a `state_mapping`. A downstream node reads it with `{ "var": "nodes.<nodeId>.<field>" }` without any explicit wiring on the upstream node:

```json
[
  { "id": "fetch", "type": "tool", "tool_id": "tool_abc" },
  {
    "id": "summarise",
    "type": "agent",
    "agent_id": "agent_xyz",
    "input_mapping": { "prompt": { "var": "nodes.fetch.text" } }
  }
]
```

`nodes` is a reserved top-level state key: [static validation](#static-validation) rejects a `state_mapping` write targeting it, and a `{ "var": "nodes.<id>..." }` reference must name an earlier (upstream) node. (An `input_schema` property named `nodes` is allowed: run input is seeded under `state.input`, so it cannot collide.) A `condition` node's namespace entry is `{ "label": "<emitted label>" }`. The field names available under `nodes.<id>` are the artifact's own — see [Node artifacts](#node-artifacts).

#### Input Mapping (JSON Logic)

Each `input_mapping` value is evaluated as [JSON Logic](https://jsonlogic.com) against the run state — the same evaluator used by `transform` and `condition` nodes:

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

A bare string is a literal value; use `{"var": "key"}` to read `state.key`. To pass a literal object that happens to look like a JSON Logic expression as data, wrap it in `preserve`, which returns its argument unevaluated: `{"preserve": {"var": "x"}}`.

#### Run input

Values passed to [`start-orchestration-run`](#examples) via `input` seed the initial state under an `input` namespace, read with `{"var": "input.key"}` — matching the pipeline/formation convention. Input keys round-trip **verbatim** (not case-transformed), so a key sent as `cycle_task` is read as `{"var": "input.cycle_task"}`. Because the `input` namespace is always seeded, a `{"var": "input.<name>"}` reference satisfies [static validation](#static-validation) regardless of the declared `input_schema`; a **flat** `{"var": "<name>"}` reference is never satisfied by run input — only by an upstream node's `state_mapping` write.

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
| Unsatisfiable `nodes.<id>` reference | a `{"var": "nodes.ghost..."}` where `ghost` is not an earlier (upstream) node in the graph — checked regardless of `input_schema` |
| Reserved `nodes` namespace write | a `state_mapping` key (e.g. `"state.nodes.x"`) targets the engine-owned `nodes` state key |

**Warnings (never block):**

| Check | Example |
| ----- | ------- |
| Conditional-branch state read | a node reads `{"var": "branch"}` that an upstream node writes only on one side of a `condition`, so it may be undefined when the node runs |

The `input_mapping` reachability check only treats an unwritten reference as an **error** when an `input_schema` is declared (a closed input contract); without one the graph stays permissive, since a parallel node's `state_mapping` may legitimately write the key first. A `{"var": "nodes.<id>..."}` reference is the one exception: an unwritten reference is always an error, open contract or not.

```bash
soat validate-orchestration \
  --nodes '[{"id":"a","type":"transform","expression":1,"state_mapping": { "state.step1": { "var": "output.result" } }},
            {"id":"b","type":"transform","expression":1,"input_mapping":{"val":{"var":"step1"}}}]' \
  --edges '[{"from":"a","to":"b"}]'
# → { "valid": true, "errors": [], "warnings": [] }
```

### Versioning

An orchestration's graph is versioned by the same append-only archive that backs [agent versions](./agents.md#versioning-and-staged-rollout) and [guardrail versions](./guardrails.md#versioning). Version 1 is written on create, and every subsequent write that **changes** the graph increments `version` and archives it as an `OrchestrationVersion`. The versioned surface is `nodes`, `edges`, `state_schema` and `input_schema`. Metadata-only edits, structurally-identical rewrites, and restoring the already-live version archive nothing. `version_label` on a create or update annotates the version that write archives; it is not itself part of the config.

**A run executes the version it started on.** `start-orchestration-run` stamps the orchestration's current `version` onto the run as `orchestration_version`, and every later step — a wake, a resume, a redrive — resolves its topology from that version. Editing an orchestration never re-shapes a run already in flight; the live columns are a **draft** for runs started from now on. To read the topology a run actually took, fetch the version its `orchestration_version` names:

```bash
soat get-orchestration-run --orchestration-run-id "$RUN_ID"
# → { "orchestration_version": 3, ... }

soat get-orchestration-version --orchestration-id "$ORCH_ID" --version 3
```

Versions are listed, fetched, and restored via `list-orchestration-versions`, `get-orchestration-version`, and `restore-orchestration-version`.

**Restore appends, it does not rewind.** Restoring v1 of an orchestration at v2 writes v1's graph back as **v3**, so a run pinned to v2 still resolves the graph it started on. Only the graph rolls back; `name` and `description` are untouched. A restored graph goes through the same static validation as an authored one. Node resource references (`agent_id`, `tool_id`, `orchestration_id`) resolve when a run reaches the node, not when the graph is written, so restoring a graph whose target has since been deleted succeeds and surfaces as a failed run.

Pinning is per run: a `loop` or `sub_orchestration` node starts a **new** run of the child orchestration, which pins the child's current version at that moment — so editing a sub-orchestration does reach iterations that have not started yet. Version the parent and the child together if you need a whole nested pipeline frozen.

### Node Executions

Every time a node runs, the engine persists an entry in the run's `node_executions` array capturing the resolved `input_mapping` it received, the `output` artifact it produced, its `status`, and — on failure — the structured `error`. The record is written even when a node throws, so `get-orchestration-run` shows **which** node failed, **what** input it received, and **why**.

Records are returned by both `get-orchestration-run` and `list-orchestration-runs`, ordered oldest-first. A node that pauses the run for human input is recorded with `status: "requires_action"`; once `submit-human-input` satisfies the pause, that same record is updated to `completed` with `output` set to the submitted payload — a re-entered pause reuses the record rather than appending another. When a run completes, nodes that were never reached (an un-traversed condition branch, an activation group that never fired) are recorded with `status: "skipped"` and `null` `input`/`output`/timestamps — walk through it in [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration). For reading back a finished run's state, see [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state).

### Run usage

Every generation an `agent` node dispatches meters against the run: its [usage](./usage.md) event carries the run's `orchestration_run_id` and the dispatching `node_id`. `get-orchestration-run` surfaces the roll-up inline as a `usage` object summed across the run's generations. For the full per-event breakdown, fetch the run receipt at [`GET /api/v1/usage/receipt?orchestration_run_id=…`](/docs/api/usage/get-usage-receipt) — see [Receipts](./usage.md#receipts-and-reconciliation). When a run is started by a [trigger](./triggers.md), the trigger id is propagated onto every in-run generation's usage event, so run spend also rolls up per trigger (`?trigger_id=`).

**Per node.** Each receipt line carries its `node_id`, so grouping the lines by it gives what each node of the run cost — the `llm_tokens` line of an `agent` node's generation and the `compute_execution` line of every node execution alike. The run total alone hides that split.

**Nested runs are metered on the child and roll up to the parent.** A `loop` or `sub_orchestration` node starts child runs, each its own run record, so their usage events carry the *child's* `orchestration_run_id`. Two figures follow from that, both on the single-run read:

- **`usage`** — what the run cost, subtree included. A `loop` over 100 items reports all 100 children here.
- **`usage_own`** — this run's own nodes only. At the node that started children you see its execution cost, not what they spent. Read it against `usage` to see where cost sits in the tree.

The children themselves are reachable with [`GET /api/v1/orchestration-runs?parent_orchestration_run_id=…`](/docs/api/orchestrations/list-orchestration-runs), and each child names the run and node that started it (`parent_orchestration_run_id`, `parent_node_id`) — so a per-child or per-node breakdown of a delegated run is a read away rather than a guess from timestamps.

:::caution Summing `usage` over a list double-counts
Because `usage` spans a subtree, a child run's spend appears twice in a list containing both it and its parent. When totalling across runs, restrict the list to the runs a caller started:

```
GET /api/v1/orchestration-runs?nested=false
```

`nested=true` gives the complement — every run started by another run, across all parents.
:::

The [receipt](./usage.md#receipts-and-reconciliation) stays self-only, deliberately: its line items carry a `node_id`, and merging a child's nodes into the parent's receipt would put node ids from two different graphs under one list.

> **Note:** usage events are metered as each generation settles, so read the roll-up from `get-orchestration-run`, not the `start-orchestration-run` response — even with `wait: true` the start response can carry `usage: null`.

### Reaching an agent node's generation

A `node_executions` entry records what a node received and what artifact it returned. For an `agent` node that artifact is the model's final answer — `{ content }`, or the parsed object when the node declares an `output_schema`. It is **not** the model's reasoning, its tool calls, or its token usage, and the record holds no generation id.

Those live on the [generation](./generations.md), which points back at the node rather than the other way round. An agent node's generation is stamped with three attribution columns — `orchestration_run_id`, `node_id`, and `node_attempt` — so the run is traced forward by filtering the generations list:

```bash
# every generation this run's agent nodes produced
soat list-generations --orchestration-run-id run_abc123

# one node's — one row per attempt if a retry policy re-ran it
soat list-generations --orchestration-run-id run_abc123 --node-id summarize
```

`node_attempt` matches the `attempt` on the corresponding `node_executions` entry, which is what makes the pairing exact for a [retried](#retry-policy) node.

Each generation returned carries its own `trace_id`, which opens the full [trace](./traces.md) for that turn — the provider call, the tool calls, and the steps in between. Note that the run's own `trace_id` is not a per-node handle: it is whichever trace the run's first agent node produced, with later nodes hanging off it as children.

### Run Tool Context

`start-orchestration-run` accepts a `tool_context` bag, the same contract as an [agent generation or session](../advanced/tool-context.md): each key/value pair is forwarded as one prefixed context header on every `http`, `mcp` and `builtin` tool call the run makes. This is how a scheduled or orchestrated flow hands a per-user credential to the tools it calls, without embedding it in the graph.

The bag is stored **on the run** and re-read at every step, so it survives every way a run gets driven — queued starts, scheduler wakes, human/approval resumes, crash redrives — and is inherited by `loop` / `sub_orchestration` child runs. Rules that carry over from the shared contract: the header name is the deployment's [context prefix](../advanced/tool-context.md#configuring-the-header-prefix) plus the key **verbatim**; an invalid or colliding key is rejected with `400 INVALID_TOOL_CONTEXT_KEY` at start time, before any run is created; the reserved identity keys (`sessionId`, `actorId`, `actorExternalId`) are stripped. `tool_context` reaches every node that calls a tool: an `agent` node's generation, and a `tool` or `poll` node's direct call — the latter being the run acting on its own behalf, which is as much the run's work as a generation is. A tool reached that way resolves its `{{context:}}` headers and [`preset_parameters`](../advanced/tool-context.md#pinning-a-parameter-to-the-runs-value) from the run's bag, which is how a run's own boundary — the one account it may act on — reaches the call with no model in between.

```bash
soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --tool-context '{"ocaToken":"eyJhbGciOiJIUzI1NiJ9.abc"}' \
  --input '{"question":"what is my balance?"}'
```

### Run Metadata

`start-orchestration-run` accepts a `metadata` bag — caller-owned key/value annotations, stored on the run and returned verbatim by every read of it, the list included. It is the run's equivalent of the same field on an agent generation, and it exists for the same reason: attributing a run to something only the caller knows about — which of *its* tenants the run belongs to, the dispatch batch that started it, the ticket that asked for it.

Two properties make it the right place for such a label, and `input` the wrong one:

- **Nothing merges it into run state.** No graph node sees it, no `{ "var": … }` reads it, and a strict `input_schema` never has to tolerate it. `input` is the run's *initial state* — a label put there is business payload every node and every schema has to accommodate.
- **The server writes nothing here, and no key is reserved.** Every piece of state the platform owns — `status`, the pinned `orchestration_version`, `trace_id`, `usage`, `artifacts`, `input`, `state` — is a field of its own, so no key a caller writes can reach platform state.

The bag lives **on the run**, so it survives every way a run is driven: a queued start whose 201 lands long before the first node executes, a scheduler wake, a human or approval resume, a crash redrive. A non-object `metadata` is rejected with `400 VALIDATION_FAILED` at start time and no run is created.

Unlike `tool_context`, it is **not** inherited by the child runs a `loop` or `sub_orchestration` node starts: a context header has to reach a nested tool call to work at all, whereas a label is a statement about the run the caller actually started. Pass one per child through the graph if a child needs its own.

```bash
soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --metadata '{"tenant_account_id":"42","dispatch_batch":"nightly-2026-08-25"}'
```

Filtering runs by a metadata key is not supported — fetch and filter client-side.

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

`required_action.type` discriminates why the run paused: `human_input` for a `human` node, `webhook_receive` for a `webhook` node in `mode: "receive"`. Both are resumed the same way — [`POST /orchestration-runs/{id}/human-input`](/docs/api/orchestrations/submit-human-input) with the paused node's `node_id` — there is no separate, independently-authenticated callback endpoint for webhook-receive nodes.

### Approval Nodes

An `approval` node proposes a guarded tool call and pauses the run for a human decision. Unlike a `human` node, it files an [ApprovalItem](./approvals.md) at emit time and is resumed **only** by resolving that item through the [Approvals](./approvals.md) queue, or by server-side expiry. The run pauses with `required_action.type: "approval"`, carrying `approval_id` and `expires_at`.

The node's `arguments`, `reasoning`, `evidence`, and `predicted_impact` mappings are resolved against run state and **frozen** onto the item at emit time. On resolution the decision (`approved` | `rejected` | `expired`) becomes the node's branch label:

- Edges labeled `condition: "approved"` / `"rejected"` / `"expired"` route by the decision.
- An **unlabeled** edge leaving an approval node follows **only on approval**; if no edge matches a `rejected`/`expired` decision, the run ends at the node.

Expiry is enforced server-side (see [Approvals — Expiry is a hard gate](./approvals.md#expiry-is-a-hard-gate)): an expired item can never execute.

### Common Errors

| Code                              | Status | Cause                                                                                       | What to do                                                                                                 |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ORCHESTRATION_VALIDATION_FAILED`  | `400`  | `create-orchestration`/`update-orchestration` rejected an invalid graph                       | Read `error.meta.errors`, or call `validate-orchestration` first — see [Static Validation](#static-validation) |
| `ORCHESTRATION_CYCLE_DETECTED`     | —      | A cycle reached execution (graphs with a cycle are normally rejected at validation time)      | Remove the cycle, or use a `loop` node if the repetition is intentional — see [Cycle Detection](#cycle-detection) |
| `ORCHESTRATION_NODE_FAILED`        | `422`  | A node could not execute as declared — a missing required field (an `agent` node without `agent_id`, a `delay` without `duration`), or an unsupported result (an `agent` node whose response streamed) | Inspect the failing node's entry in `node_executions` for the exact `error` — see [Node Executions](#node-executions) |
| _the underlying code_              | varies | A node threw while executing. The originating error propagates **unchanged** rather than being wrapped — a referenced `agent_id`/`tool_id` that no longer exists surfaces `RESOURCE_NOT_FOUND`, and a failing `http` tool surfaces that tool's own error | Do not key error handling on `ORCHESTRATION_NODE_FAILED` for these; read the failing node's `error.code` from `node_executions` |
| `ORCHESTRATION_POLL_EXHAUSTED`     | —      | A `poll` node's `max_iterations` was reached with `failOnTimeout: true`                       | Raise `max_iterations`/`interval`, or handle `conditionMet: false` downstream instead of setting `failOnTimeout` — see [Polling](#polling) |

**A run appears stuck in a non-terminal state:** `queued` means no worker has claimed its task yet — confirm a worker is running (the API process runs one unless `ORCHESTRATION_WORKER_DISABLED=true`). `sleeping` is a parked `delay`/`poll` wait or retry backoff (`active_nodes` names the node) and resumes on its own. `awaiting_input` waits for `submit-human-input`. `running` for far longer than expected self-heals: the reaper reclaims any run whose lease has expired within `ORCHESTRATION_RUN_LEASE_TTL_MS` — see [Durable Background Execution](#durable-background-execution).

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `SOAT_RUN_TOKEN_TTL` | No | Lifetime of the run-as token minted for each background drive segment (default `1h`). It covers one drive, not the whole run, so a run sleeping for days never holds a long-lived credential. See [Run identity](#durable-background-execution). |
| `ORCHESTRATION_SCHEDULER_INTERVAL_MS` | No | Scheduler tick interval in ms (default `5000`). |
| `ORCHESTRATION_RUN_LEASE_TTL_MS` | No | How long a `running` run's lease is valid before the reaper may reclaim it, in ms (default `600000`). Must exceed the longest single round of node execution. |
| `ORCHESTRATION_WORKER_INTERVAL_MS` | No | Worker loop tick interval in ms (default `5000`). |
| `ORCHESTRATION_TASK_LEASE_TTL_MS` | No | How long a claimed queue task's lease is valid before it may be redelivered, in ms (default `60000`). |
| `ORCHESTRATION_WORKER_DISABLED` | No | Set to `true` to keep the API process request-only, leaving the queue to a dedicated worker. |
| `ORCHESTRATION_WORKER_BATCH` | No | Maximum tasks a worker claims per tick (default `10`). |
| `ORCHESTRATION_WORKER_CONCURRENCY` | No | Global cap on simultaneously claimed, unacked tasks per worker process (unset = no cap). See [Concurrency limits](#concurrency-limits). |
| `ORCHESTRATION_QUEUE_DRIVER` | No | Queue backend: `postgres` (default) or `sqs`. An unknown value is rejected at startup. |
| `ORCHESTRATION_QUEUE_SQS_QUEUE_URL` | With `sqs` | The SQS queue URL tasks are published to and received from. |
| `ORCHESTRATION_QUEUE_SQS_REGION` | No | Region for the SQS client (falls back to `AWS_REGION`, then `us-east-1`). |
| `ORCHESTRATION_QUEUE_SQS_ENDPOINT` | No | Override the SQS endpoint (LocalStack / ElasticMQ). Credentials otherwise resolve through the standard AWS provider chain. |
| `ORCHESTRATION_WORKER_HEARTBEAT_FILE` | No | Where a standalone worker publishes its liveness heartbeat. Unset (the default for the in-API worker) writes nothing. |
| `ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS` | No | How old the heartbeat may be before the worker healthcheck fails (default `30000`). Must exceed `ORCHESTRATION_WORKER_INTERVAL_MS`. |

## Examples

### Create a sequential pipeline

The `fetch` node maps `output.text` because a `tool` node's artifact is its tool's result object verbatim — substitute whatever field your tool returns (see [Node artifacts](#node-artifacts)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-orchestration \
  --project-id "$PROJECT_ID" \
  --name "fetch-and-summarize" \
  --nodes '[
    {"id":"fetch","type":"tool","tool_id":"tool_abc","state_mapping": { "state.raw": { "var": "output.text" } }},
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
        state_mapping: { 'state.raw': { var: 'output.text' } },
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
        "state_mapping": { "state.raw": { "var": "output.text" } }
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

Returns immediately with `status: "queued"`; a worker claims the run and drives it in the background. Add `wait: true` (`--wait` in the CLI) to block until the run settles (see [Durable Background Execution](#durable-background-execution)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Background (default): returns a queued run immediately
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

### Parallel fan-out and fan-in

Both `branch_a` and `branch_b` run concurrently after `start` completes; `merge` runs only after **both** complete because its edges share an `activation_group` with `activation_condition: "all"`:

```json
{
  "nodes": [
    { "id": "start", "type": "transform", "expression": { "var": "query" } },
    { "id": "branch_a", "type": "agent", "agent_id": "agent_a", "state_mapping": { "state.a": { "var": "output.content" } } },
    { "id": "branch_b", "type": "agent", "agent_id": "agent_b", "state_mapping": { "state.b": { "var": "output.content" } } },
    { "id": "merge", "type": "transform", "expression": { "cat": [{ "var": "a" }, { "var": "b" }] } }
  ],
  "edges": [
    { "from": "start", "to": "branch_a" },
    { "from": "start", "to": "branch_b" },
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

A team of agents plus the flow that coordinates them can deploy as a single [Formation](./formations.md) stack, because an orchestration is itself a formation resource type. A node's `agent_id` uses a [`ref` expression](./formations.md#ref-expressions) to bind to an agent created in the same template; SOAT resolves it to the physical `agent_...` ID before the orchestration is created. Node fields are written in snake_case (`agent_id`, `input_mapping`, `state_mapping`), exactly as in this module's REST contract. For a full step-by-step build — the template, deploy, and run — see [Create an Agent Squad](/docs/tutorials/create-an-agent-squad).
