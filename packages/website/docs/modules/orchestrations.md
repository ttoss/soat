---
description: "DAG-based pipeline definitions that chain agents, tools, and knowledge lookups into repeatable pipelines."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Orchestrations

DAG-based pipeline definitions for chaining agents, tools, and knowledge lookups into repeatable pipelines.

## Overview

An orchestration is a directed acyclic graph (DAG) of nodes, each one discrete operation. Nodes in the same round run in parallel; edges with activation groups control fan-in. The graph stays deterministic and auditable where an `agent` node reasons internally. See [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph).

An orchestration is a pipeline that ends; a [workflow](./workflows.md) is a state graph a task lives in. [Choosing an Automation Model](/docs/advanced/choosing-an-automation-model) compares them, starting with [whether the work needs a graph at all](/docs/advanced/choosing-an-automation-model#step-0--you-may-need-neither); an orchestration is the [graph layer](/docs/agent-system-layers), built last. An orchestration can be a [Formation](./formations.md) resource ([Create an Agent Squad](/docs/tutorials/create-an-agent-squad)) and a [Trigger](./triggers.md) target (`target_type: orchestration`).

> See the [Permissions Reference](../permissions.md#orchestrations) for the IAM action strings for this module.

## Related Tutorials

- [Orchestration Control Flow: Delay, Poll, and Loop](/docs/tutorials/orchestration-control-flow) — `delay`, `poll`, `loop`, and `condition` nodes in one run
- [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration) — branch routing and `skipped` node executions
- [Orchestrate a Sonnet - Step 6 (Create the orchestration graph)](/docs/tutorials/orchestrate-a-sonnet#step-6--create-the-orchestration-graph)
- [Orchestrate a Sonnet - Step 7 (Start a run)](/docs/tutorials/orchestrate-a-sonnet#step-7--start-a-run)
- [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state)
- [Create an Agent Squad](/docs/tutorials/create-an-agent-squad) — agents plus a coordinating orchestration as one stack
- [Close the Monthly Books - Step 4 (Validate and create the reconciliation graph)](/docs/tutorials/close-the-monthly-books#step-4--validate-and-create-the-reconciliation-graph) — parallel start nodes, an `activation_group` join, an arithmetic branch

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
| `usage`            | object         | What the run cost: token/cost roll-up (`input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `cost_usd`) summed across this run's generations **and every run it started** through `loop` / `sub_orchestration` nodes, at any depth (see [Run usage](#run-usage)). Present on the single-run read; omitted from run list responses |
| `usage_own`        | object         | The same roll-up restricted to **this run's own nodes**, excluding nested runs. Equal to `usage` for a run with no children. Present on the single-run read; omitted from run list responses |
| `required_action`  | object \| null | Present when status is `awaiting_input` — why the run is parked (see [Human Nodes](#human-nodes) and [Pausing a run](#pausing-a-run)) |
| `pause_requested_at` | string \| null | ISO 8601 instant an operator pause was requested, or `null` when none is in force. Independent of `status` (see [Pausing a run](#pausing-a-run)) |
| `pause_reason`     | string \| null | The reason supplied with the pause, when one was               |
| `trace_id`         | string \| null | Linked observability trace, if any                                |
| `input`            | object \| null | Initial input provided at run creation                            |
| `tool_context`     | object \| null | Caller context forwarded as `X-Soat-Context-*` headers on the tool calls of the run — every `agent` node's generation, and every `tool` / `poll` node's call (see [Run Tool Context](#run-tool-context)) |
| `metadata`         | object \| null | Caller-owned annotations supplied at run creation and returned verbatim; never merged into `state` (see [Run Metadata](#run-metadata)) |
| `output`           | object \| null | Terminal node artifact(s) when the run has `succeeded`            |
| `parent_orchestration_run_id` | string \| null | The run whose node started this one — set only on a `loop` / `sub_orchestration` child, null for a run a caller started |
| `parent_node_id`   | string \| null | The node within `parent_orchestration_run_id` that started this run |
| `orchestration_run_depth`        | integer        | `loop` / `sub_orchestration` edges between this run and the one a caller started: `0` for a caller-started run, one more than its parent's for a child (see [Nesting depth](#nesting-depth)) |
| `started_at`       | string \| null | ISO 8601 execution start timestamp                                |
| `completed_at`     | string \| null | ISO 8601 terminal timestamp (`succeeded`/`failed`/`cancelled`/`expired`) |
| `created_at`       | string         | ISO 8601 creation timestamp                                       |
| `updated_at`       | string         | ISO 8601 last-updated timestamp                                   |

### NodeExecution

One entry per node execution, in chronological order.

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

A record holds external I/O only (resolved input, returned artifact) and no generation id; see [Reaching an agent node's generation](#reaching-an-agent-nodes-generation).

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
| `loop`         | Iterates a state collection, running a sub-orchestration per item. Uses `orchestration_id`, `collection`, `item_variable`, `parallelism`, and `context_keys`. See [Loops](#loops-collection-iteration). |
| `poll`         | Calls a tool on an interval until a JSON Logic exit condition on the response holds. Uses `tool_id`, `exit_condition`, and `interval`. See [Polling](#polling). |
| `delay`        | Waits for a fixed `duration`, then continues. Accepts `5s`/`5m`/`2h`/`500ms` or ISO 8601 (`PT5S`).                                   |
| `emit_event`   | Emits an internal event of type `event_type` carrying the `input_mapping` result as the event `data`. See [Emitting events](#emitting-events). |
| `webhook`      | Pauses awaiting an inbound callback (`mode: "receive"`). The run enters `awaiting_input` with `required_action.type: "webhook_receive"`; resume it via `human-input`. (To send data _out_ of a graph, use `emit_event`.) |
| `sub_orchestration` | Runs another orchestration as a single step. Uses `orchestration_id`. The node's artifact is the **child run's `output`** — `{ terminalNodeId: terminalArtifact }`, not a flattened value. `state_mapping` values are JSON Logic, whose `var` reader descends dot-paths, so `{"var": "output.terminalNodeId.someField"}` pulls a deep field directly. |

### Node artifacts

Every completed node produces an **artifact**: what `state_mapping` reads as `output` and downstream nodes read as [`nodes.<id>`](#the-nodesid-namespace).

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

On a `tool` node returning a JSON object, `{"var": "output.result"}` resolves to `null`; map the field the tool returns.

#### Agent node `output_schema`

With an `output_schema`, an `agent` node's artifact resolves in order: (1) the provider's structured output, when the agent's own `output_schema` reaches it as a generation-time constraint ([Agents](./agents.md)); (2) the raw text parsed as JSON after stripping one markdown code fence; (3) `{ content }`, the node still completing. A mismatch never fails the run (a `soat:orchestrations` debug log records the parse failure). It is a parsing aid, not a validation gate: a parsed object is accepted whether or not it satisfies the schema, and a node-level `output_schema` differing from the agent's is not forwarded to the model.

> **Tip:** a `state_mapping` that writes `null` usually read a field the artifact lacks; every artifact is visible under `state.nodes.<id>` in `get-orchestration-run`.

### Guardrail interception on tool nodes

[Guardrails](./guardrails.md) classify a `tool` node's call at dispatch over the **project + tool** scopes (no agent in scope); the strictest [action class](./guardrails.md#action-classes) applies:

- **A / passing B** — the tool runs with the (cleaned) `input_mapping` result.
- **C (human sign-off)** — the run parks on the node (`required_action.type: "approval"`) and files an [ApprovalItem](./approvals.md) with the frozen arguments, like an [approval node](#approval-nodes). Approval re-dispatches the tool and follows its success edge; rejection/expiry never runs it and only a matching `condition: "rejected"` / `"expired"` edge follows.
- **D / tripwire** — a routable **`blocked`** outcome: a `{ status, reason }` artifact plus a `blocked` (or `tripwire`) branch label for an edge with `condition: "blocked"`. An unlabeled success edge does not follow a blocked node.

Guardrails attach to the [tool](./tools.md) (or the project) via `guardrail_ids`; there is no per-node guardrail field.

### Loops (collection iteration)

A `loop` node runs a **sub-orchestration once per item** of an array in run state (`poll` repeats until a condition instead).

| Field | Default | Purpose |
| --- | --- | --- |
| `orchestration_id` | — (required) | Public ID of the orchestration to run for each item (same field the `sub_orchestration` node uses) |
| `collection` | `state.items` | State path to the array to iterate; a path without the `state.` prefix is normalised to one. A missing or non-array value yields zero iterations |
| `item_variable` | `item` | Each element is passed as the sub-run's **input** under this key; run input is seeded under the `input` namespace, so the sub-graph reads it with `{"var": "input.item"}` |
| `parallelism` | `5` | Items are processed in batches of this size |
| `context_keys` | `null` | Allowlist of the run's `tool_context` keys each child inherits; `null` hands down the whole bag, `[]` none. See [Narrowing what a child run inherits](#narrowing-what-a-child-run-inherits) |

Artifact: `{ results: [...] }`, one entry per item in order, each the sub-run's `output`. A graph with a `loop` node is exempt from [cycle detection](#static-validation).

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

A `poll` node calls a [Tool](./tools.md) until a [JSON Logic](https://jsonlogic.com) **exit condition** on its response holds. Each attempt calls `toolId` (resolving `inputMapping` against state, like a `tool` node), then evaluates `exitCondition` against run state plus `response` (latest result) and `attempt` (1-based). Truthy stops; otherwise the run parks and the scheduler drives the next attempt after `interval`, up to `maxIterations` (default 10, ceiling 1000). No request is held open, so there is no wall-clock ceiling; a poll can span days.

Artifact: `{ result, attempts, conditionMet, timedOut }`. On exhaustion the node completes with `conditionMet: false` (branch on it with a `condition` node) unless `failOnTimeout: true`, which fails the run with `ORCHESTRATION_POLL_EXHAUSTED`.

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

`poll` and `delay` waits run on the background scheduler ([Durable Background Execution](#durable-background-execution)) and survive a restart.

### Emitting events

An `emit_event` node emits an **internal event**, calling no URL; any [webhook](./webhooks.md) subscribed to the event type in the run's project delivers it (signed, retried, tracked, policy-gated), so the graph holds no URL or secret.

- **`event_type`** — e.g. `guardrail.exception`; subscribe with `create-webhook --events "guardrail.exception"` (or a pattern like `guardrail.*`).
- **`input_mapping`** — resolved against run state as the event `data`.

Fire-and-forget: the node completes on emit and the run never blocks on or fails from delivery. Artifact: `{ emitted: true, eventType: "<type>" }`. For a synchronous call whose failure must fail the run, use an `http` [tool](./tools.md) node.

```json
{
  "id": "alert",
  "type": "emit_event",
  "event_type": "guardrail.exception",
  "input_mapping": { "reason": { "var": "state.exception" } }
}
```

The event carries `resource_type: "orchestration_run"` and the run's id as `resource_id` for scoping; envelope and signature in [Delivery](./webhooks.md#delivery).

### Retry Policy

Any node can declare `retry`. On a **transient** error with attempts left, the run parks as `sleeping` and re-executes the node after a backoff on the scheduler (survives a restart, holds no worker). Absent, or `max_attempts <= 1`, is fail-fast.

Retriable: infrastructure errors (network, timeouts, provider SDK throws) and upstream `5xx`. Terminal: `4xx` business errors (validation, not found, conflict), which fail the run at once without consuming attempts. Each attempt writes its own `node_executions` record with an incrementing `attempt`.

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

A **retry** (new attempt) is not deduped; a **redelivery** of the same attempt is ([Idempotency](#idempotency-of-node-execution)).

### Durable Background Execution

Runs execute in a **queue-backed durable worker**, detached from the starting request:

- `start-orchestration-run` persists the run, enqueues a `continue` task and returns `status: "queued"`; no node executes in the request. Follow with `get-orchestration-run` or lifecycle [webhook](./webhooks.md) events. By default the worker loop runs inside the API process.
- `delay` and `poll` waits park the run as **`sleeping`** (DB state only, no worker); the scheduler enqueues a `wake` task at the persisted wake time, so `delay: "2h"` survives a restart.
- `human` and `webhook (mode: receive)` nodes park the run as **`awaiting_input`**. `submit-human-input` applies the payload, drives the run inline and returns the settled result; `resume-orchestration-run` carries no `node_id` or payload, so it re-drives from the last checkpoint and re-parks on the same node.
- An **operator** parks a run with [`POST /api/v1/orchestration-runs/{orchestration_run_id}/pause`](/docs/api/orchestrations/pause-orchestration-run) ([Pausing a run](#pausing-a-run)).

**Run identity.** Each run persists its starting principal (user or API key); every background drive re-mints a short-lived **run-as token** from it, confined to the run's project, so a [`builtin` tool](./tools.md#builtin) node can call the platform from a durable run.

- **Identity only, not permissions.** Authorization is evaluated per call against current policies; revoking access affects a run in flight.
- **Never wider than the starting credential.** A key-started run is bounded by the key's policies; revoking the key stops it, with no fallback to the owner's access.
- **Attributed to the key, not its owner.** A key-started run names the key (`key_…`) in [task history](./workflows.md#transition-history), the [audit log](./audit-log.md), and the principal a later automation hop inherits.
- **Trigger- and OAuth-started runs record no principal.** They execute inline with the original token (the trigger's attached policy, the consented scope); their platform self-calls are unauthenticated and fail with `TOOL_HTTP_ERROR` carrying the upstream 401.

Nested `loop` / `sub_orchestration` children inherit the parent's identity; a [workflow](./workflows.md)-dispatched agent gets the same, keyed to the task.

**Queue driver.** `enqueue` / `claim` / `ack` / `retry`, selected with `ORCHESTRATION_QUEUE_DRIVER`. Both drivers are at-least-once with lease-based redelivery:

| | `postgres` (default) | `sqs` |
| --- | --- | --- |
| Backing store | `orchestration_run_tasks` table (`SELECT … FOR UPDATE SKIP LOCKED` + lease) | an SQS queue (visibility timeout **is** the lease) |
| Per-project `max_concurrent_runs` | **enforced** at claim time | **not enforced** |
| `oldest_queued_age_seconds`, `per_project` stats | reported | `null` / empty |

Postgres needs no extra infrastructure. A backoff longer than SQS's 15-minute maximum delay becomes 15 minutes; the persisted `wake_at` still decides whether there is work. An unrecognized `ORCHESTRATION_QUEUE_DRIVER`, or `sqs` without a queue URL, fails with `QUEUE_DRIVER_MISCONFIGURED` (no fallback to Postgres).

**Separate worker process.** `node dist/worker.js` runs only the scheduler tick + worker loop (no HTTP listener); set `ORCHESTRATION_WORKER_DISABLED=true` on the request-only API tier. On `SIGTERM`/`SIGINT` it stops claiming, finishes claimed tasks and leaves the rest un-acked for redelivery. It writes a heartbeat file after every **successful** claim (`ORCHESTRATION_WORKER_HEARTBEAT_FILE`); `workerHealthcheck.mjs` exits `0` only while that file is younger than `ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS`.

**Crash recovery.** A `running` run holds a **lease** (`lease_expires_at`), refreshed after every completed round. A reaper reclaims expired leases and enqueues a `continue` task; completed nodes are skipped and only the unfinished frontier re-executes.

**Synchronous (compatibility) mode.** `wait: true` on `start-orchestration-run` blocks until the run is terminal (`succeeded`/`failed`) or `awaiting_input`. Nested `loop` / `sub_orchestration` runs always execute synchronously so their output can be aggregated. See [Synchronous vs Asynchronous Execution](../advanced/sync-and-async.md).

**Lifecycle events** ([Webhooks](./webhooks.md)): `orchestration_runs.started`, `orchestration_runs.awaiting_input`, `orchestration_runs.succeeded`, `orchestration_runs.failed`.

#### Idempotency of node execution

Each **side-effecting** node execution (`agent`, `tool`, `memory_write`, `emit_event`, `sub_orchestration`, `loop`) is written under a run-scoped idempotency key `{orchestration_run_id}:{node_id}:{attempt}`, inserted `running` **before** the side effect and updated in place after. A **redelivery** of the same `(run, node, attempt)` finds the key `completed` and reuses the stored output; a **retry** (new attempt) is a new key and runs for real.

A worker that crashes between the side effect and marking the key `completed` leaves a `running` key, and the redelivering worker re-executes under it. An `http` tool node forwards its key verbatim as an **`Idempotency-Key`** request header so downstream services can dedupe that window. Pure nodes (`condition`, `transform`, `delay`, `human`, `approval`, `webhook`) are unkeyed.

### Pausing a run

[`POST /api/v1/orchestration-runs/{orchestration_run_id}/pause`](/docs/api/orchestrations/pause-orchestration-run) parks a run in flight at its next **checkpoint**; [`POST /api/v1/orchestration-runs/{orchestration_run_id}/resume`](/docs/api/orchestrations/resume-orchestration-run) re-drives it from there. [`POST /api/v1/orchestration-runs/{orchestration_run_id}/cancel`](/docs/api/orchestrations/cancel-orchestration-run) discards completed work; a pause keeps the checkpoint and defers the rest.

The parked run carries `required_action.type: "paused"` with the operator's `reason`. `pause_requested_at` is set independently of `status`: a `running` run reads as paused until the round in flight reaches its checkpoint.

| The run was… | What pause does |
| --- | --- |
| `running` | The round in flight finishes; the loop parks the **frontier** — the nodes that had not started — at the checkpoint after it. Nothing after that runs |
| `queued` | Parked immediately, with the graph's start nodes as the frontier. Nothing has executed |
| `sleeping` | Parked immediately, **keeping the wake it was due**. The scheduler only claims a `sleeping` run, so the wake finds a parked run and does nothing; resuming puts it back to `sleeping` at the instant it already was |
| `awaiting_input` | The node's own `required_action` stands, unchanged. The pause is still recorded, which is what refuses `submit-human-input` below |

Pausing is **idempotent** (a second pause answers with the run unchanged); a settled run answers `409 ORCHESTRATION_RUN_NOT_PAUSABLE`.

**Only `resume` lifts a pause.** While one is in force, `submit-human-input` answers `409 ORCHESTRATION_RUN_PAUSED` and an [approval](./approvals.md) decision does not drive the run; resolving the item still records the decision, and resume re-drives the parked node, which files a fresh proposal.

**A pause fans out to nested runs; a resume does not.** Every `loop` / `sub_orchestration` descendant parks at its own next checkpoint, and a child started after the pause is born paused. Each descendant is resumed by its own id, reachable through `parent_orchestration_run_id`.

**A pause does not reach work in flight**: the current round's nodes, including a nested child started in it, finish.

### Listing the runs still driving

[`GET /api/v1/orchestration-runs`](/docs/api/orchestrations/list-orchestration-runs) filters on `status` beside `orchestration_id`, `parent_orchestration_run_id` and `nested`. The parameter **repeats**; values are ORed:

```
GET /api/v1/orchestration-runs?status=queued&status=running&status=sleeping&status=awaiting_input
```

The listing is newest-first; without the filter, finding live work means paging every run. There is no `non_terminal` shorthand (a run parked `awaiting_input` spends nothing; which statuses count as live is the caller's call). A value outside the [status enum](#orchestrationrun), empty string included, is a `400 VALIDATION_FAILED`.

### Concurrency limits

- **Per project.** [`max_concurrent_runs`](./projects.md) caps runs actively driven at once, enforced at queue **claim time**: excess tasks stay `queued` (never failed) until a slot frees. `null` (default) is unlimited. A run parked `sleeping` or `awaiting_input` holds no task or slot; a run never blocks on itself. **Postgres** driver only.
- **Global (per worker).** `ORCHESTRATION_WORKER_CONCURRENCY` caps claimed-and-unacked tasks per worker process; `ORCHESTRATION_WORKER_BATCH` is the per-tick claim size, so each tick claims `min(BATCH, CONCURRENCY − in-flight)`. P workers bound global parallelism at `P × CONCURRENCY`.

### Queue metrics

[`GET /api/v1/orchestrations/queue/stats`](/docs/api/orchestrations/get-queue-stats) snapshots waiting vs. claimed task counts, the oldest waiting task's age, claim-latency percentiles (in-process, rolling 5-minute window) and a per-project breakdown. `driver` names the backend; under `sqs`, `oldest_queued_age_seconds` / `per_project` are `null` / empty. Guarded by `orchestrations:GetQueueStats`.

A project-scoped caller gets `per_project` for its projects, `queue_depth` and `claimed_tasks` summed over them, and `null` for `oldest_queued_age_seconds` and both `claim_latency_ms` percentiles (deployment-wide, not narrowable). A caller granted the action on every project gets deployment-wide figures.

### State and Mappings

- **`input_mapping`** — node input keys resolved against run state before execution; each value is [JSON Logic](https://jsonlogic.com) ([Input Mapping](#input-mapping-json-logic)).
- **`state_mapping`** — projects the artifact into state after execution. Each **key** is a write path starting with `state.` (normalized if missing). Each **value** is JSON Logic over `{ "output": <the node's artifact>, "state": <run state> }`, the same evaluator as `input_mapping`/`transform`/`condition`. A literal is written as-is; a **dotted** target such as `"state.proposed.action_id"` builds a nested object, read back with `{"var": "proposed.action_id"}`; `{ "state.count": { "+": [{ "var": "state.count" }, { "var": "output.delta" }] } }` accumulates a total.

  ```json
  { "id": "summarise", "type": "agent", "agent_id": "agent_xyz", "state_mapping": { "state.summary": { "var": "output.content" } } }
  ```

Run **state** = the run input ([Run input](#run-input)) + every upstream `state_mapping` write + every upstream artifact under `nodes.<id>`. `transform` and `condition` evaluate `expression` against full state; other node types receive only their `input_mapping` result; `poll` also evaluates `exit_condition` against state plus `response` and `attempt`.

#### The `nodes.<id>` namespace

Every completed node's artifact is recorded at `state.nodes.<nodeId>`, `state_mapping` or not; downstream reads it with `{ "var": "nodes.<nodeId>.<field>" }`:

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

`nodes` is a reserved top-level state key: [static validation](#static-validation) rejects a `state_mapping` write targeting it, and a `{ "var": "nodes.<id>..." }` reference must name an upstream node. An `input_schema` property named `nodes` is fine, since run input is seeded under `state.input`. A `condition` node's entry is `{ "label": "<emitted label>" }`; other field names are the artifact's own ([Node artifacts](#node-artifacts)).

#### Input Mapping (JSON Logic)

Each `input_mapping` value is [JSON Logic](https://jsonlogic.com) over run state (same evaluator as `transform` and `condition`):

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

`{"var": "key"}` reads `state.key`. A literal object that looks like JSON Logic goes in `preserve`, which returns its argument unevaluated: `{"preserve": {"var": "x"}}`.

#### Run input

`input` on [`start-orchestration-run`](#examples) seeds state under the `input` namespace, read with `{"var": "input.key"}`. Keys round-trip **verbatim** (`cycle_task` → `{"var": "input.cycle_task"}`). `input` is always seeded, so `{"var": "input.<name>"}` satisfies [static validation](#static-validation) regardless of `input_schema`; a **flat** `{"var": "<name>"}` is satisfied only by an upstream `state_mapping` write, never by run input.

### Parallel Execution

Nodes active in the same round run concurrently via `Promise.all`; their outputs and state mutations are applied sequentially afterwards. A node with several outgoing edges activates all targets in parallel.

### Activation Groups (Fan-In)

Edges may carry an `activation_group` name and an `activation_condition`:

| `activation_condition` | Behaviour                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default)        | The target node activates only after **every** edge in the group comes from a completed node.                                     |
| `any`                  | The target node activates as soon as **any** edge in the group comes from a completed node. Activated at most once per run.       |

Edges without an `activation_group` always pass through unconditionally.

### Cycle Detection

A DFS cycle check runs at create/update ([Static Validation](#static-validation)) and before a run begins; graphs with a `loop` node are exempt. A cycle reaching execution creates the run as `failed` with `error.code: "ORCHESTRATION_CYCLE_DETECTED"`.

### Nesting depth

Cycle detection is intra-graph, so it cannot see a graph naming itself in a `sub_orchestration` node, directly or through two graphs naming each other. Every run carries `orchestration_run_depth`: `0` for a caller-started run, one more than its parent's for a `loop` / `sub_orchestration` child. Starting a child past the bound **fails the run that tried to descend** with `ORCHESTRATION_RUN_DEPTH_LIMIT`, before the child's record exists; `error.meta` names the depth reached, the limit and `limit_source`.

The bound is the **smaller** of two numbers (a project can be stricter than the deployment, never looser):

| Bound | Where | Default |
| --- | --- | --- |
| `MAX_ORCHESTRATION_RUN_DEPTH` | deployment env var | 10 |
| [`max_orchestration_run_depth`](./projects.md) | the project | `null` (defer to the deployment's) |

Both are read when the child starts, not pinned on the root, so lowering the number stops a tree already recursing.

This bounds **recursion**, not total work: a `loop` fans out, so `N` children per level still permits `N^depth` runs; width is bounded by `parallelism` and the project's [`max_concurrent_runs`](#concurrency-limits). Since a child's failure fails its parent (below), the error reaches the run a caller reads.

### A child run's failure fails its parent

A `loop` / `sub_orchestration` child settling **non-success terminal** (`failed`, `cancelled`, `expired`) fails the node that started it and so the parent run, as a [workflow `on_enter` dispatch](./workflows.md) does. The parent's `error.code` is the **child's own code** where it has one; `error.meta` names the child run and node, so `parent_orchestration_run_id` walks down to the failure. A parked child (`awaiting_input`, `sleeping`) is unaffected.

### Static Validation

Graphs are validated **before** persistence: `create-orchestration` / `update-orchestration` reject an invalid graph with `400` (`code: "ORCHESTRATION_VALIDATION_FAILED"`), `error.meta` carrying the `errors` and `warnings` arrays. `validate-orchestration` runs the same checks without persisting and returns `{ valid, errors, warnings }`.

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

An unwritten `input_mapping` reference is an **error** only under a declared `input_schema` (a closed input contract); without one a parallel node's `state_mapping` may write the key first, so the graph stays permissive. An unwritten `{"var": "nodes.<id>..."}` reference is always an error.

```bash
soat validate-orchestration \
  --nodes '[{"id":"a","type":"transform","expression":1,"state_mapping": { "state.step1": { "var": "output.result" } }},
            {"id":"b","type":"transform","expression":1,"input_mapping":{"val":{"var":"step1"}}}]' \
  --edges '[{"from":"a","to":"b"}]'
# → { "valid": true, "errors": [], "warnings": [] }
```

### Versioning

The graph is versioned by the same append-only archive as [agent versions](./agents.md#versioning-and-staged-rollout) and [guardrail versions](./guardrails.md#versioning). Version 1 is written on create; every write that **changes** the graph increments `version` and archives it as an `OrchestrationVersion`. Versioned surface: `nodes`, `edges`, `state_schema`, `input_schema`. Metadata-only edits, structurally identical rewrites and restoring the live version archive nothing. `version_label` on a create or update annotates the archived version; it is not part of the config.

**A run executes the version it started on.** `start-orchestration-run` stamps `version` onto the run as `orchestration_version`; every later step (wake, resume, redrive) resolves its topology from it. Editing never re-shapes a run in flight; the live graph is a **draft** for runs started from now on. To read a run's topology, fetch the version `orchestration_version` names:

```bash
soat get-orchestration-run --orchestration-run-id "$RUN_ID"
# → { "orchestration_version": 3, ... }

soat get-orchestration-version --orchestration-id "$ORCH_ID" --version 3
```

Versions: `list-orchestration-versions`, `get-orchestration-version`, `restore-orchestration-version`.

**Restore appends, it does not rewind.** Restoring v1 at v2 writes v1's graph back as **v3**; a run pinned to v2 still resolves its graph. Only the graph rolls back; `name` and `description` are untouched. A restored graph passes the same static validation. Node references (`agent_id`, `tool_id`, `orchestration_id`) resolve when a run reaches the node, not at write time, so restoring a graph whose target was deleted succeeds and surfaces as a failed run.

Pinning is per run: a `loop` / `sub_orchestration` node starts a **new** child run pinned to the child's version at that moment, so editing a sub-orchestration reaches iterations not yet started. Version parent and child together to freeze a nested pipeline.

### Node Executions

Every node run persists a `node_executions` entry: resolved `input_mapping`, `output` artifact, `status`, and on failure the structured `error`, written even when the node throws, so `get-orchestration-run` shows which node failed, with what input, and why.

`get-orchestration-run` and `list-orchestration-runs` return them oldest-first. A node paused for human input is `status: "requires_action"`; when `submit-human-input` satisfies it, the same record becomes `completed` with the payload as `output` (a re-entered pause reuses the record). On completion, nodes never reached (an un-traversed condition branch, an activation group that never fired) are `status: "skipped"` with `null` `input`/`output`/timestamps ([Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration)). Reading a finished run: [Orchestrate a Sonnet - Step 9 (Inspect the run state)](/docs/tutorials/orchestrate-a-sonnet#step-9--inspect-the-run-state).

### Run usage

Every generation an `agent` node dispatches meters against the run: its [usage](./usage.md) event carries `orchestration_run_id` and the dispatching `node_id`. `get-orchestration-run` rolls it up as `usage`; the per-event breakdown is [`GET /api/v1/usage/receipt?orchestration_run_id=…`](/docs/api/usage/get-usage-receipt) ([Receipts](./usage.md#receipts-and-reconciliation)). A [trigger](./triggers.md)-started run propagates the trigger id onto every in-run generation's usage event, so spend also rolls up per trigger (`?trigger_id=`).

**Per node.** Each receipt line carries `node_id`: the `llm_tokens` line of an `agent` node's generation and the `compute_execution` line of every node execution.

**Nested runs are metered on the child and roll up to the parent.** A `loop` / `sub_orchestration` child's usage events carry the *child's* `orchestration_run_id`. On the single-run read:

- **`usage`** — subtree included; a `loop` over 100 items reports all 100 children.
- **`usage_own`** — this run's own nodes only.

Children: [`GET /api/v1/orchestration-runs?parent_orchestration_run_id=…`](/docs/api/orchestrations/list-orchestration-runs); each names its starter (`parent_orchestration_run_id`, `parent_node_id`).

:::caution Summing `usage` over a list double-counts
`usage` spans a subtree, so a child's spend appears twice in a list holding it and its parent. Total over caller-started runs only:

```
GET /api/v1/orchestration-runs?nested=false
```

`nested=true` gives the complement — every run started by another run, across all parents.
:::

The [receipt](./usage.md#receipts-and-reconciliation) stays self-only: its lines carry a `node_id`, and a child's nodes belong to another graph.

Usage is metered as each generation settles: read the roll-up from `get-orchestration-run`, not the `start-orchestration-run` response, which can carry `usage: null` even with `wait: true`.

### Reaching an agent node's generation

An `agent` node's `node_executions` artifact is the final answer (`{ content }`, or the parsed object with an `output_schema`); reasoning, tool calls and token usage live on the [generation](./generations.md), which is stamped with `orchestration_run_id`, `node_id` and `node_attempt`. Filter the generations list:

```bash
# every generation this run's agent nodes produced
soat list-generations --orchestration-run-id run_abc123

# one node's — one row per attempt if a retry policy re-ran it
soat list-generations --orchestration-run-id run_abc123 --node-id summarize
```

`node_attempt` equals the `attempt` on the matching `node_executions` entry, pairing a [retried](#retry-policy) node exactly.

Each generation carries its own `trace_id` for the full [trace](./traces.md) of that turn. The run's `trace_id` is the trace of its first agent node, later nodes as children, not a per-node handle.

### Run Tool Context

`start-orchestration-run` accepts a `tool_context` bag, the same contract as an [agent generation or session](../advanced/tool-context.md): each key/value pair becomes one prefixed context header on every `http`, `mcp` and `builtin` tool call the run makes, so a per-user credential reaches the tools without living in the graph.

The bag is stored **on the run** and re-read at every step (queued start, scheduler wake, human/approval resume, crash redrive) and inherited in full by `loop` / `sub_orchestration` children unless the node sets [`context_keys`](#narrowing-what-a-child-run-inherits). Header name = the deployment's [context prefix](../advanced/tool-context.md#configuring-the-header-prefix) + the key **verbatim**; an invalid or colliding key is `400 INVALID_TOOL_CONTEXT_KEY` at start time, before any run is created; the reserved identity keys (`session_id`, `actor_id`, `actor_external_id`) are stripped. It reaches an `agent` node's generation and a `tool` or `poll` node's direct call; such a tool resolves its `{{context:}}` headers and [`preset_parameters`](../advanced/tool-context.md#pinning-a-parameter-to-the-runs-value) from the run's bag.

```bash
soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --tool-context '{"ocaToken":"eyJhbGciOiJIUzI1NiJ9.abc"}' \
  --input '{"question":"what is my balance?"}'
```

#### Narrowing what a child run inherits

`context_keys` on a `loop` or `sub_orchestration` node bounds what the child inherits, as [the same field on a tool](tools.md#scoping-which-context-keys-reach-a-tool) bounds what egresses to it:

```json
{
  "id": "enrich",
  "type": "sub_orchestration",
  "orchestration_id": "orch_shared_enrichment",
  "context_keys": ["tenant"]
}
```

A run carrying `{"ocaToken": "…", "tenant": "acme"}` hands that child `tenant` only. Rules match the tool-level allowlist: omitted inherits everything, `[]` nothing, matching is case-insensitive (an entry names a header), and an entry outside the header-name grammar is `400 INVALID_TOOL_CONTEXT_KEY` at write time. A child re-derives `session_id`, `actor_id` and `actor_external_id` per generation regardless of the list.

### Run Metadata

`start-orchestration-run` accepts a `metadata` bag: caller-owned annotations (tenant, dispatch batch, ticket) stored on the run and returned verbatim by every read, the list included. Unlike `input`:

- **Nothing merges it into run state.** No node sees it, no `{ "var": … }` reads it, a strict `input_schema` never has to tolerate it.
- **The server writes nothing here; no key is reserved.** `status`, `orchestration_version`, `trace_id`, `usage`, `artifacts`, `input`, `state` are fields of their own.

It survives every drive (queued start, scheduler wake, human or approval resume, crash redrive). A non-object `metadata` is `400 VALIDATION_FAILED` at start time; no run is created. Unlike `tool_context`, it is **not** inherited by `loop` / `sub_orchestration` children; pass one per child through the graph.

```bash
soat start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --metadata '{"tenant_account_id":"42","dispatch_batch":"nightly-2026-08-25"}'
```

Filtering runs by a metadata key is not supported; filter client-side.

### Human Nodes

At a `human` node the run pauses and the run read carries `required_action`:

```json
{
  "required_action": {
    "type": "human_input",
    "node_id": "approval",
    "prompt": "Please approve or reject."
  }
}
```

`required_action.type`: `human_input` for a `human` node, `webhook_receive` for a `webhook` node in `mode: "receive"`, `paused` for an [operator pause](#pausing-a-run) (no node; carries a `reason`). The first two resume via [`POST /orchestration-runs/{id}/human-input`](/docs/api/orchestrations/submit-human-input) with the paused `node_id`; webhook-receive nodes have no separate callback endpoint.

### Approval Nodes

An `approval` node proposes a guarded tool call, files an [ApprovalItem](./approvals.md) at emit time and pauses with `required_action.type: "approval"` (`approval_id`, `expires_at`). It resumes **only** by resolving that item through the [Approvals](./approvals.md) queue or by server-side expiry ([Expiry is a hard gate](./approvals.md#expiry-is-a-hard-gate): an expired item never executes).

`arguments`, `reasoning`, `evidence` and `predicted_impact` mappings are resolved against run state and **frozen** onto the item at emit time. The decision (`approved` | `rejected` | `expired`) is the node's branch label:

- Edges labeled `condition: "approved"` / `"rejected"` / `"expired"` route by decision.
- An **unlabeled** edge follows **only on approval**; with no edge matching `rejected`/`expired`, the run ends at the node.

### Common Errors

| Code                              | Status | Cause                                                                                       | What to do                                                                                                 |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ORCHESTRATION_VALIDATION_FAILED`  | `400`  | `create-orchestration`/`update-orchestration` rejected an invalid graph                       | Read `error.meta.errors`, or call `validate-orchestration` first — see [Static Validation](#static-validation) |
| `ORCHESTRATION_CYCLE_DETECTED`     | —      | A cycle reached execution (graphs with a cycle are normally rejected at validation time)      | Remove the cycle, or use a `loop` node if the repetition is intentional — see [Cycle Detection](#cycle-detection) |
| `ORCHESTRATION_NODE_FAILED`        | `422`  | A node could not execute as declared — a missing required field (an `agent` node without `agent_id`, a `delay` without `duration`), or an unsupported result (an `agent` node whose response streamed) | Inspect the failing node's entry in `node_executions` for the exact `error` — see [Node Executions](#node-executions) |
| _the underlying code_              | varies | A node threw while executing. The originating error propagates **unchanged** rather than being wrapped — a referenced `agent_id`/`tool_id` that no longer exists surfaces `RESOURCE_NOT_FOUND`, and a failing `http` tool surfaces that tool's own error | Do not key error handling on `ORCHESTRATION_NODE_FAILED` for these; read the failing node's `error.code` from `node_executions` |
| `ORCHESTRATION_POLL_EXHAUSTED`     | —      | A `poll` node's `max_iterations` was reached with `failOnTimeout: true`                       | Raise `max_iterations`/`interval`, or handle `conditionMet: false` downstream instead of setting `failOnTimeout` — see [Polling](#polling) |
| `ORCHESTRATION_RUN_DEPTH_LIMIT`    | `409`  | Starting the next `loop` / `sub_orchestration` child would nest past the effective bound — usually a graph naming itself, directly or through a cycle of two graphs | Walk `parent_orchestration_run_id` up from the failed run to find the node that re-enters a graph already in the chain; raise the project's `max_orchestration_run_depth` only if the composition is legitimately that deep — see [Nesting depth](#nesting-depth) |
| `ORCHESTRATION_NESTED_RUN_FAILED`  | `422`  | A `loop` / `sub_orchestration` child settled `failed`/`cancelled`/`expired` carrying no code of its own | Read the child run (`parent_orchestration_run_id` points back at this one) — a child that *does* carry a code fails its parent under that code instead — see [A child run's failure fails its parent](#a-child-runs-failure-fails-its-parent) |
| `ORCHESTRATION_RUN_NOT_PAUSABLE`   | `409`  | The run has already settled, so there is nothing left to pause                                | Nothing to do — a settled run keeps its result; pause only applies while a run is `queued`, `running`, `sleeping` or `awaiting_input` — see [Pausing a run](#pausing-a-run) |
| `ORCHESTRATION_RUN_PAUSED`         | `409`  | `submit-human-input` was called while an operator pause is in force                           | Resume the run first, then submit the payload — an operator pause is not liftable by satisfying the node behind it — see [Pausing a run](#pausing-a-run) |

**A run stuck non-terminal:** `queued` — no worker claimed its task; confirm one runs (the API process does unless `ORCHESTRATION_WORKER_DISABLED=true`). `sleeping` — a `delay`/`poll` wait or retry backoff (`active_nodes` names the node); resumes on its own. `awaiting_input` — waits for `submit-human-input`, or [`resume-orchestration-run`](#pausing-a-run) when `required_action.type` is `paused`. `running` too long self-heals: the reaper reclaims the run once its lease is older than `ORCHESTRATION_RUN_LEASE_TTL_MS` ([Durable Background Execution](#durable-background-execution)).

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `SOAT_RUN_TOKEN_TTL` | No | Lifetime of the run-as token minted for each background drive segment (default `1h`). It covers one drive, not the whole run, so a run sleeping for days never holds a long-lived credential. See [Run identity](#durable-background-execution). |
| `MAX_ORCHESTRATION_RUN_DEPTH` | No | `loop` / `sub_orchestration` nesting levels a run tree may reach before the next child is refused (default `10`). A project's `max_orchestration_run_depth` can be stricter, never looser. See [Nesting depth](#nesting-depth). |
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

`fetch` maps `output.text`, a field of the tool's own result ([Node artifacts](#node-artifacts)); substitute yours.

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

Returns `status: "queued"`; `wait: true` (`--wait`) blocks until the run settles ([Durable Background Execution](#durable-background-execution)).

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

### Pause and resume a run

See [Pausing a run](#pausing-a-run).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat pause-orchestration-run \
  --orchestration-run-id orch_run_01 \
  --reason "credit balance went negative"

soat resume-orchestration-run --orchestration-run-id orch_run_01
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.orchestrations.pauseOrchestrationRun({
  path: { orchestration_run_id: 'orch_run_01' },
  body: { reason: 'credit balance went negative' },
});
if (error) throw new Error(JSON.stringify(error));

await soat.orchestrations.resumeOrchestrationRun({
  path: { orchestration_run_id: 'orch_run_01' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/orchestration-runs/orch_run_01/pause \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "credit balance went negative"}'

curl -X POST https://api.example.com/api/v1/orchestration-runs/orch_run_01/resume \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Parallel fan-out and fan-in

`branch_a` and `branch_b` run concurrently after `start`; `merge` waits for **both** via a shared `activation_group` with `activation_condition: "all"`:

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

Edges carry `condition: "<label>"`; unselected nodes are recorded `skipped`. Walkthrough: [Conditional Branching in Orchestrations](/docs/tutorials/conditional-orchestration).

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

Agents plus their coordinating orchestration deploy as one [Formation](./formations.md) stack. A node's `agent_id` takes a [`ref` expression](./formations.md#ref-expressions) to an agent in the same template, resolved to the physical `agent_...` ID before the orchestration is created. Node fields are snake_case (`agent_id`, `input_mapping`, `state_mapping`), as in REST. Full build: [Create an Agent Squad](/docs/tutorials/create-an-agent-squad).
