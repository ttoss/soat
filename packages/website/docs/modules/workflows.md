---
description: "State-machine definitions (workflows) and the durable, stateful work items that live in them (tasks)."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Workflows & Tasks

A **workflow** is a state machine (states, transitions, guards, per-state automation); a **task** is a durable item moving through it over time, backward included.

## Overview

The workflow is the versioned definition; the task is a durable instance that does not terminate on its own and can revisit states. An [orchestration](./orchestrations.md) is a forward-only DAG that runs and ends; a workflow is a state graph a task lives in (statuses, guarded transitions, a kanban board, backward moves). They compose: a state may **dispatch** an orchestration, an agent or a single tool call. [Choosing an Automation Model](/docs/advanced/choosing-an-automation-model) compares them, starting with [whether the work needs a graph at all](/docs/advanced/choosing-an-automation-model#step-0--you-may-need-neither); a workflow is the [graph layer](/docs/agent-system-layers), built last.

- **`states`** — board columns. Exactly one is `initial`; any number are `terminal` (entering one closes the task). A `kind: human` state never dispatches: the task parks until a principal fires a transition. A state may declare `on_enter` automation ([Per-state automation](#per-state-automation-on_enter)).
- **`transitions`** — named, directional moves `from` listed states `to` one destination. Backward moves are ordinary transitions.

Creating a task places it in the `initial` state (or a named `state`, [Alternate entry points](#alternate-entry-points)) and fires its `on_enter`. Every later move (human, API, agent via MCP, automation outcome) goes through the single **transition** operation, so guards and the audit trail cannot be bypassed; `state` is never directly writable. [`GET /tasks?workflow_id=…&state=…`](/docs/api/tasks/list-tasks) is one board column.

> See the [Permissions Reference](../permissions.md#workflows) for the
> `workflows:` action strings and [#tasks](../permissions.md#tasks) for the
> `tasks:` action strings.

## Related Tutorials

- [Write a Sonnet with a Workflow](/docs/tutorials/orchestrate-a-sonnet-with-workflows) — agent-driven states, a human review, a backward move
- [Close the Monthly Books - Step 8 (Define the close period as a workflow)](/docs/tutorials/close-the-monthly-books#step-8--define-the-close-period-as-a-workflow) — a guarded, approval-gated transition beside an orchestration

## Data Model

### Workflow

| Field            | Type            | Description                                        |
| ---------------- | --------------- | -------------------------------------------------- |
| `id`             | string          | Public identifier (`wfl_…`)                        |
| `project_id`     | string          | Owning project (hard security boundary)            |
| `name`           | string          | Human-readable name, unique per project            |
| `description`    | string \| null  | Optional description                               |
| `version`        | integer         | Incremented on every write that changes the state machine; prior versions are archived (see [Versioning](#versioning)) |
| `states`         | array           | State definitions (see below)                      |
| `transitions`    | array           | Allowed moves (see below)                          |
| `payload_schema` | object \| null  | Optional JSON Schema validated against task payloads |
| `created_at`     | string          | ISO 8601 creation timestamp                        |
| `updated_at`     | string          | ISO 8601 last-updated timestamp                    |

#### State

| Field           | Type            | Description                                                          |
| --------------- | --------------- | ------------------------------------------------------------------- |
| `name`          | string          | Unique within the workflow                                          |
| `initial`       | boolean         | Exactly one state must be `true` — where new tasks start            |
| `terminal`      | boolean         | Entering a terminal state closes the task (`status: closed`)        |
| `kind`          | string \| null  | `human` marks a parking state that never dispatches                 |
| `on_enter`      | object \| null  | Automation fired when a task enters this state (see below)          |
| `stalled_after` | integer \| null | Seconds a task may sit in this state before a `tasks.stalled` event fires (positive integer, or null to never stall). See [Stall detection](#stall-detection). |

#### Transition

| Field               | Type           | Description                                                        |
| ------------------- | -------------- | ----------------------------------------------------------------- |
| `name`              | string         | Unique within the workflow; the name a caller fires               |
| `from`              | string[]       | Source states this transition is valid from                       |
| `to`                | string         | The single destination state                                      |
| `guard`             | object \| null | [JSON Logic](https://jsonlogic.com) over `{task, transition, principal}`; a false result rejects the move with `TASK_GUARD_REJECTED` |
| `requires_approval` | boolean        | Gate the move behind a human approval. Firing it parks a pending approval instead of transitioning. See [Approval-gated transitions](#approval-gated-transitions). |

Only defined transitions fire; an any-state transition lists every state in `from`.

### Task

| Field               | Type             | Description                                                              |
| ------------------- | ---------------- | ----------------------------------------------------------------------- |
| `id`                | string           | Public identifier (`task_…`)                                            |
| `project_id`        | string           | Owning project (hard security boundary)                                 |
| `workflow_id`       | string           | The workflow definition this task is bound to                           |
| `workflow_version`  | integer \| null  | The workflow version this task runs on, fixed when the task was created (see [Versioning](#versioning)). `null` for tasks created before pinning existed, which run on the live definition |
| `title`             | string           | Human-readable label                                                    |
| `state`             | string           | Current state name. Read-only — moved only via a transition             |
| `status`            | `open` \| `closed` | `closed` once the task enters a `terminal` state                      |
| `payload`           | object           | Caller-owned task data; input to guards and dispatch `input_mapping`s. The engine never writes into it except declared `payload_writes` |
| `metadata`          | object \| null   | Caller-owned annotations supplied at creation and returned verbatim; invisible to guards and to `payload_writes` (see [Task metadata](#task-metadata)) |
| `last_result`       | any \| null      | Server-owned, read-only: the result of the current state's last completed dispatch, overwritten on every dispatch. Guards read it as `task.last_result` |
| `assignee`          | string \| null   | Informational in v1 (a user or actor public ID; not interpreted by the engine) |
| `active_dispatch`   | object \| null   | `{ kind, id, status }` of the current state's dispatch, if any — plus `attempt` while a `retry` policy is in effect. `kind` is `generation`, `orchestration_run` or `tool_call`; a `tool_call` always carries a null `id`, since a direct tool call leaves no addressable record |
| `automation_status` | string \| null   | `running` \| `completed` \| `failed` \| `unrouted` for the current state's dispatch, or `paused` when an operator pause suppressed it before it ran (see [Pausing a task](#pausing-a-task)) |
| `pause_requested_at` | string \| null  | ISO 8601 instant an operator paused this task's automation, or `null` when no pause is in force (see [Pausing a task](#pausing-a-task)) |
| `pause_reason`      | string \| null   | The reason supplied with the pause, when one was                        |
| `automation_chain_depth` | integer     | Server-owned, read-only: how many machine-driven transitions have run back-to-back with no outside intervention. Reset to `0` by any move a person, a plain API key, or an approval resolution makes. See [The automation chain budget](#the-automation-chain-budget) |
| `pending_transition`| string \| null   | Name of a `requires_approval` transition parked awaiting a human decision; null otherwise |
| `tool_context`      | object           | **Write-only.** Caller context for the task's automation dispatches, accepted on `create-task` and `transition-task` and never returned by a read. See [Dispatch tool context](#dispatch-tool-context) |
| `entered_state_at`  | string           | When the task entered its current state                                 |
| `created_at`        | string           | ISO 8601 creation timestamp                                             |
| `updated_at`        | string           | ISO 8601 last-updated timestamp                                         |

#### Transition history

Every move appends one `TaskTransition` record; [`GET /tasks/{id}/history`](/docs/api/tasks/get-task-history) returns them oldest-first.

| Field           | Type            | Description                                                        |
| --------------- | --------------- | ----------------------------------------------------------------- |
| `id`            | string          | Public identifier (`task_tr_…`)                                   |
| `task_id`       | string          | Owning task                                                        |
| `from_state`    | string \| null  | Source state (`null` on the initial placement)                    |
| `to_state`      | string          | Destination state                                                 |
| `transition`    | string \| null  | Transition name fired (`null` for the initial placement)          |
| `principal_kind`| string          | `user` \| `api_key` \| `automation` \| `approval`                 |
| `principal_id`  | string \| null  | The principal that made the move. For `api_key` auth this is the API key's own id (`key_…`), distinguishing which key acted. `null` for `automation`, which has no principal — read `generation_id` / `orchestration_run_id` / `tool_id` for the cause |
| `generation_id` | string \| null  | The agent generation that caused the move (set for both `on_complete` routing and `on_failure`, linking the failed generation) |
| `orchestration_run_id`        | string \| null  | The orchestration run that caused the move, when automation-driven |
| `tool_id`       | string \| null  | The tool a `tool` dispatch called, when that dispatch caused the move. A tool call produces no record of its own, so the tool is the cause |
| `note`          | string \| null  | Optional reason supplied by the caller                            |
| `created_at`    | string          | ISO 8601 timestamp                                                |

## Key Concepts

- **Single transition path.** The transition must exist, be valid from the current state, and its guard must pass, whoever fires it.
- **Atomicity & conflicts.** The state change runs under a row lock; concurrent transitions on one task serialize. A transition no longer valid from the committed state, or on a `closed` task, is `TASK_TRANSITION_CONFLICT` (409). The post-dispatch write (`active_dispatch`, `automation_status`, `last_result`, `payload_writes`) re-validates under the same lock; a stale write is discarded.
- **Delete is guarded.** A workflow with **open** tasks cannot be deleted (`WORKFLOW_HAS_OPEN_TASKS`); once every task is closed, deleting it removes those tasks and their history.
- **Payload is working data.** [`PATCH /tasks/{id}`](/docs/api/tasks/update-task) updates `payload`, `title` or `assignee`. `payload` is **shallow-merged** (omitted keys kept) and validated against `payload_schema`. No patch reaches read-only `last_result`, so a guard on `task.last_result` is satisfied only by a value an automation wrote. Payload writes are not versioned.

### Per-state automation (`on_enter`)

`on_enter` dispatches **at most one** agent generation, orchestration run or tool call on entry and routes the outcome into a transition:

```json
{
  "name": "drafting",
  "initial": true,
  "on_enter": {
    "dispatch": {
      "kind": "agent",
      "agent_id": "agent_x1",
      "input_mapping": {
        "prompt": { "cat": ["Write about ", { "var": "task.payload.topic" }] }
      },
      "payload_writes": {
        "draft_id": { "var": "result.object.document_id" }
      }
    },
    "retry": { "max_attempts": 3, "backoff_seconds": 5, "backoff_multiplier": 2 },
    "on_complete": [
      { "when": { "==": [{ "var": "result.category" }, "simple"] }, "transition": "to_review" },
      { "when": true, "transition": "to_review" }
    ],
    "on_failure": null
  }
}
```

- **`dispatch`** — `kind: agent` (`agent_id`), `kind: orchestration` (`orchestration_id`) or `kind: tool` (`tool_id`, optional `operation_id` for a multi-operation tool). `input_mapping` is JSON Logic over `{task}` resolving the dispatch input (a `tool` dispatch's arguments). `payload_writes` (optional) is JSON Logic over `{task, result}`, written into named `task.payload` keys atomically with `last_result` on completion, so a value outlives the one hop `last_result` covers. Each write overwrites its key; in a loop an earlier pass's value lingers until the state dispatches again.
- **`on_complete`** — rules evaluated in order against `{task, result}`; the first match fires its transition **as the `automation` principal** (same guards). `{result}` is the generation output (agent), the final run state (orchestration) or the return value (tool), also written to `task.last_result`. No match → `automation_status: completed` and a `tasks.automation_unrouted` event. A matched transition rejected (guard fails for `automation`, or a concurrent move invalidated it) → `automation_status: unrouted` and a `tasks.automation_rejected` event carrying the matched `transition` and the rejection `errorCode`.
- **`retry`** (optional) — covers **execution** failures, never `on_complete` routing. `max_attempts` counts the first attempt (1–10); the delay before attempt `n` is `backoff_seconds * backoff_multiplier^(n - 2)` (defaults: 0, 1). `on_failure`, or the parked `automation_status: failed`, fires only after the last attempt; leaving the state between attempts abandons the rest. Each attempt is `active_dispatch.attempt`; every retried failure emits `tasks.automation_retrying` (`attempt`, `max_attempts`, the error, the failed `generation_id`/`orchestration_run_id`).
- **`on_failure`** — transition fired on terminal dispatch failure. Omitted → the task stays with `automation_status: failed` for a human.

Entering a state cancels any dispatch still running from the state left, an in-flight orchestration run included: task state is the source of truth.

#### Tool dispatch

A single tool call dispatches directly:

```json
{
  "name": "notifying",
  "on_enter": {
    "dispatch": {
      "kind": "tool",
      "tool_id": "tool_...",
      "input_mapping": { "channel": { "var": "task.payload.channel" } }
    },
    "on_complete": [{ "when": true, "transition": "to_notified" }]
  }
}
```

`input_mapping` resolves the arguments; the return value becomes `{result}` and `task.last_result`. The call passes the **same guardrails** as the identical call from an orchestration `tool` node and lands in the activity feed the same way. It settles within the dispatch: `active_dispatch.kind: tool_call` with a null `id`, and the resulting transition carries `tool_id` as provenance.

Two cases fail the dispatch with `TOOL_DISPATCH_FAILED` and belong behind an **orchestration** dispatch:

- a guardrail routes the tool to **human approval** (class C): a task dispatch has no run to park and resume;
- a guardrail **blocks** the call (class D, or a class-B tripwire): it never ran, so it is a dispatch failure routable through `on_failure`.

#### Waiting, polling, and multi-step work

`on_enter` dispatches **one** thing. To wait, poll or run several steps, dispatch an **orchestration** and use its [node types](./orchestrations.md) (`delay`, `poll`, …). A task dispatch starts the run in durable mode, so the background scheduler owns the wait:

```json
{
  "name": "awaiting_settlement",
  "on_enter": {
    "dispatch": { "kind": "orchestration", "orchestration_id": "orc_..." },
    "on_complete": [{ "when": true, "transition": "to_settled" }]
  }
}
```

The run parks `sleeping` and resumes on its own; the task sits with `automation_status: running` until the run settles, then routes through `on_complete` / `on_failure`. There is no `kind: delay` or `kind: poll`; a one-node orchestration expresses it.

#### Recovery after a restart

The run behind a dispatch is durable, but the wait for its outcome lives in the process that started it. If the server restarts with a dispatch outstanding (typically a run `sleeping` through a long `delay` or `poll`), the run still finishes on the scheduler and a background reconciler routes the task when it does.

The reconciler considers only a dispatch that has read `running` longer than `TASKS_DISPATCH_RECONCILE_GRACE_MS` (default `60000`), so a healthy in-process hand-off is never raced. The recovered outcome routes like a live one: same `on_complete` / `on_failure` rules, same `automation` principal, the run as cause.

`kind: agent` dispatches are not reconciled: a generation parked in `requires_action` awaiting client tool outputs is legitimately outstanding.

### Pausing a task

[`POST /api/v1/tasks/{task_id}/pause`](/docs/api/tasks/pause-task) suppresses every state's `on_enter` dispatch and every retry chain behind one (the task-level counterpart of [pausing an orchestration run](./orchestrations.md#pausing-a-run)); [`POST /api/v1/tasks/{task_id}/resume`](/docs/api/tasks/resume-task) lifts it.

**A paused task still transitions.** Entering a state whose dispatch is suppressed records `automation_status: paused`; resume reads it to know the `on_enter` still owes its work, and never re-spends a completed dispatch.

**The resumed dispatch runs as whoever resumed**, not whoever last moved the task.

**A dispatch in flight finishes**, and its outcome still routes (into a state whose own dispatch is then suppressed). A task-dispatched orchestration run is not paused with its task; pause it through its own route.

Pausing is **idempotent**; a closed task answers `409 TASK_NOT_PAUSABLE`, and resuming with no pause in force answers `409 TASK_NOT_PAUSED`.

### Finding the tasks whose automation is running

[`GET /api/v1/tasks`](/docs/api/tasks/list-tasks) filters on `automation_status` beside `status`, `state`, `workflow_id` and `assignee`; `status=open` narrows to the cards in play. The parameter **repeats**; values are ORed:

```
GET /api/v1/tasks?status=open&automation_status=running&automation_status=paused
```

`none` selects a `null` `automation_status` (never entered a state with an automation); omitted means every task. It is `none`, not `null`, because the CLI reads the token `null` as JSON null. A value outside `running` / `completed` / `failed` / `unrouted` / `paused` / `none`, empty string included, is `400 VALIDATION_FAILED`.

### Versioning

The state machine is versioned by the same append-only archive as [agent versions](./agents.md#versioning-and-staged-rollout), [guardrail versions](./guardrails.md#versioning) and [orchestration versions](./orchestrations.md#versioning). Version 1 is written on create; every write that **changes** the definition increments `version` and archives a `WorkflowVersion`. Versioned surface: `states`, `transitions`, `payload_schema`.

**A task runs on the version it entered on.** [`POST /tasks`](/docs/api/tasks/create-task) stamps `version` onto the task as `workflow_version`; validating a transition, parking an approval gate and validating a payload patch all read that version. Editing never re-shapes a task in flight; the live definition is a draft for tasks created from now on.

Archive nothing: a metadata-only edit (`name`, `description`); re-writing the definition already held (compared structurally); restoring the live version. `version_label` on a create or update annotates the archived version and is never itself a change.

| Operation | Endpoint |
| --- | --- |
| List versions, newest first | [`GET /api/v1/workflows/{workflow_id}/versions`](/docs/api/workflows/list-workflow-versions) |
| Fetch one version | [`GET /api/v1/workflows/{workflow_id}/versions/{version}`](/docs/api/workflows/get-workflow-version) |
| Roll back to a version | [`POST /api/v1/workflows/{workflow_id}/versions/{version}/restore`](/docs/api/workflows/restore-workflow-version) |

**Restore appends, it does not rewind.** Restoring v1 at v2 writes v1's definition back as **v3**; a task pinned to v2 still runs on it. Only the definition rolls back; `name` and `description` are untouched. A restored definition passes the same validation, including resolving every `on_enter` dispatch target, so a version whose agent or orchestration was deleted fails with `WORKFLOW_VALIDATION_FAILED` (400).

### Alternate entry points

[`POST /tasks`](/docs/api/tasks/create-task) accepts an optional `state` to create the task in instead of `initial`. Entry behaves like a transition (`entered_state_at` set, `on_enter` fires, the stall clock arms) with one history entry (`from_state: null`, `transition: null`). An unknown `state` is `TASK_STATE_NOT_FOUND` (400).

### Approval-gated transitions

Firing a `requires_approval: true` transition (user, API key or automation outcome) does **not** move the task: it parks a pending [ApprovalItem](./approvals.md) (`origin: task_transition`, carrying `task_id` and `task_transition`) and returns the task with `pending_transition` set. No other transition fires while the gate is open (`TASK_TRANSITION_CONFLICT`, 409); one gate per task. Resolve it through the [approvals](./approvals.md) endpoints:

- **Approve** → the transition fires **as the `approval` principal** through the single transition path, guard **re-evaluated at resolution time**; if no longer valid, the gate clears and `tasks.approval_failed` fires with `transition` and `errorCode`.
- **Reject** → the gate clears; history gets a note (`principal_kind: approval`, `transition: null`). The task never moved.
- **Expire** → the approvals expiry sweeper clears the gate and appends an expiry note.

### Task metadata

`create-task` accepts a `metadata` bag: caller-owned annotations (tenant, originating ticket, import batch) stored on the task and returned verbatim by every read, the list included.

- **`payload` is part of the machine**: guards read `task.payload`, dispatch `input_mapping`s read it, `payload_writes` overwrite keys in it.
- **`metadata` is inert**: no guard, mapping or engine write touches it. Everything the engine decides (`state`, `status`, `workflow_version`, `last_result`, `active_dispatch`, the automation fields) is a field of its own.

Unlike write-only `tool_context`, `metadata` is readable, and it survives every transition (a transition supplies none). A non-object `metadata` is `400 VALIDATION_FAILED`; no task is created.

```bash
soat create-task \
  --workflow-id "$WORKFLOW_ID" \
  --title 'Refund request #8123' \
  --metadata '{"tenant_account_id":"42","source":"zendesk"}'
```

Filtering tasks by a metadata key is not supported; filter client-side.

### Dispatch tool context

A task carries a [`tool_context`](../advanced/tool-context.md): a flat `Record<string, string>` forwarded as context headers on every `http`, `mcp` and `builtin` tool call its dispatches make: an `agent` dispatch's generation, a `tool` dispatch's call (also resolving the tool's `{{context:}}` [headers and pinned parameters](../advanced/tool-context.md#pinning-a-parameter-to-the-runs-value)), and an `orchestration` dispatch's run, on to every node and child run ([Run Tool Context](./orchestrations.md#run-tool-context)).

**It attaches per move**; creation is the first move:

| Request | Effect on the stored bag |
| --- | --- |
| `create-task --tool-context '{…}'` | Sets it. This is what the entry state's `on_enter` runs with |
| `transition-task --tool-context '{…}'` | **Replaces** it wholesale |
| `transition-task` with no `tool_context` | **Keeps** the current one |
| `transition-task --tool-context '{}'` | Clears it, without closing the task |
| Any transition into a `terminal` state | Cleared — a closed task holds no credential |

A dispatch runs with the credential of whoever last moved the task. Moves supplying no bag preserve it: automated hops (`on_complete` / `on_failure`), `retry` attempts, approval resolutions (the *gated* move's bag is stored when the gate parks and used when it resolves). A [stall](#stall-detection) is an event, not a move.

Reserved identity keys are stripped and re-derived server-side; an invalid key is `INVALID_TOOL_CONTEXT_KEY` (400) ([Validation](../advanced/tool-context.md#validation)). **The bag is write-only**: no read returns it. Confine a key to the tools that need it with [`context_keys`](./tools.md#scoping-which-context-keys-reach-a-tool).

### Stall detection

A state may declare `stalled_after` (seconds). A sweeper emits a `tasks.stalled` webhook event when an **open** task has sat in the state longer. An **event, not a transition**: the task does not move; route on it via a webhook or trigger. Fires once per stall episode, re-armed by the next transition.

### The automation chain budget

A cycle turning on its own (dispatch, outcome routes back, dispatch again) is bounded by `automation_chain_depth`; each transition increments or resets it:

| The move | Effect |
| --- | --- |
| A dispatch outcome routed through `on_complete` / `on_failure` (the `automation` principal) | increments |
| A `transition-task` call from a dispatched run or agent, made with its run-as token | increments |
| A person, a plain API key, or an approval resolution | resets to `0` |

When the depth would exceed `TASK_AUTOMATION_CHAIN_LIMIT` (default `50`), the transition is refused with `TASK_AUTOMATION_CHAIN_LIMIT` **before** the state change, so the next `on_enter` never fires; the task parks `automation_status: unrouted` and `tasks.automation_rejected` fires. A dispatched run or agent is recognized by its [run-as token](./orchestrations.md#durable-background-execution), not its principal. Any human touch restarts the budget.

### Deploying as a formation

[Formation](./formations.md) resource type `workflow`; `properties` mirror the REST body (`name`, `description`, `states`, `transitions`, `payload_schema`), and an `on_enter` dispatch's `agent_id` / `orchestration_id` accept `{ "ref": "LogicalId" }`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TASK_AUTOMATION_CHAIN_LIMIT` | No | How many machine-driven transitions a task may run back-to-back with no outside intervention before the next one is refused (default `50`). See [The automation chain budget](#the-automation-chain-budget). |

## Error Codes

| Code                       | Status | When                                                            |
| -------------------------- | ------ | --------------------------------------------------------------- |
| `WORKFLOW_NOT_FOUND`       | 404    | The workflow does not exist or is not accessible               |
| `WORKFLOW_VALIDATION_FAILED`| 400   | The workflow definition is invalid                             |
| `WORKFLOW_HAS_OPEN_TASKS`  | 409    | The workflow has open tasks and cannot be deleted              |
| `TASK_NOT_FOUND`           | 404    | The task does not exist or is not accessible                   |
| `TASK_PAYLOAD_INVALID`     | 400    | The payload violates the workflow's `payload_schema`           |
| `TASK_STATE_NOT_FOUND`     | 400    | [`POST /tasks`](/docs/api/tasks/create-task) `state` does not name a declared state of the workflow |
| `TASK_TRANSITION_NOT_FOUND`| 400    | The named transition does not exist in the workflow            |
| `TASK_GUARD_REJECTED`      | 400    | The transition guard evaluated to false                        |
| `TASK_TRANSITION_CONFLICT` | 409    | The transition is not valid from the current state, or the task is closed |
| `TASK_AUTOMATION_PROVENANCE_MISSING` | 500 | An `automation` transition would be persisted with `principal_id`, `generation_id`, `orchestration_run_id`, and `tool_id` all null — rejected as a writer bug rather than silently recorded |
| `TOOL_DISPATCH_FAILED` | 422 | A `tool` dispatch's call was settled before it ran — blocked by a guardrail, or routed to human approval, which a task dispatch cannot park on |
| `INVALID_TOOL_CONTEXT_KEY`  | 400    | A `tool_context` key on `create-task` / `transition-task` is not a valid header name, or two keys collide on one header. See [Dispatch tool context](#dispatch-tool-context) |
| `TASK_AUTOMATION_CHAIN_LIMIT` | 409 | The task has run `TASK_AUTOMATION_CHAIN_LIMIT` machine-driven transitions with no outside intervention; the next one is refused. See [The automation chain budget](#the-automation-chain-budget) |
| `TASK_NOT_PAUSABLE`        | 409    | The task is closed, so it has no automation left to pause. See [Pausing a task](#pausing-a-task) |
| `TASK_NOT_PAUSED`          | 409    | The task carries no operator pause to lift; advance an idle task by firing a transition instead. See [Pausing a task](#pausing-a-task) |

## Webhook events

| Event                        | When                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `tasks.created`              | A task is created and placed in its initial state        |
| `tasks.transitioned`         | A task moves between states                              |
| `tasks.closed`               | A task enters a terminal state                           |
| `tasks.automation_unrouted`  | A dispatch completed but no `on_complete` rule matched   |
| `tasks.automation_rejected`  | A matched `on_complete` transition was rejected (guard or conflict) |
| `tasks.automation_retrying`  | A dispatch attempt failed and a `retry` attempt remains (carries `attempt`, `max_attempts`, the error, and the failed generation/run id) |
| `tasks.stalled`              | An open task sat in a state past its `stalled_after` (once per episode) |
| `tasks.approval_failed`      | An approved gated transition could no longer apply at resolution time (guard or conflict) |
| `tasks.paused`               | An operator paused a task's automation                   |
| `tasks.resumed`              | An operator lifted a task's pause                        |

## Examples

### Create a workflow

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-workflow \
  --project-id "$PROJECT_ID" \
  --name "Content Pipeline" \
  --states '[{"name":"draft","initial":true},{"name":"review","kind":"human"},{"name":"published","terminal":true}]' \
  --transitions '[{"name":"to_review","from":["draft"],"to":"review"},{"name":"revise","from":["review"],"to":"draft"},{"name":"publish","from":["review"],"to":"published"}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: workflow } = await soat.workflows.createWorkflow({
  body: {
    project_id: PROJECT_ID,
    name: 'Content Pipeline',
    states: [
      { name: 'draft', initial: true },
      { name: 'review', kind: 'human' },
      { name: 'published', terminal: true },
    ],
    transitions: [
      { name: 'to_review', from: ['draft'], to: 'review' },
      { name: 'revise', from: ['review'], to: 'draft' },
      { name: 'publish', from: ['review'], to: 'published' },
    ],
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/workflows" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "project_id": "'"$PROJECT_ID"'",
    "name": "Content Pipeline",
    "states": [{"name":"draft","initial":true},{"name":"review","kind":"human"},{"name":"published","terminal":true}],
    "transitions": [{"name":"to_review","from":["draft"],"to":"review"},{"name":"revise","from":["review"],"to":"draft"},{"name":"publish","from":["review"],"to":"published"}]
  }'
```

</TabItem>
</Tabs>

### Create a task and fire a transition

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
TASK_ID=$(soat create-task \
  --project-id "$PROJECT_ID" \
  --workflow-id "$WORKFLOW_ID" \
  --title "Blog post: launch recap" \
  --payload '{"topic":"launch recap"}' | jq -r '.id')

soat transition-task --task-id "$TASK_ID" --transition to_review --note "ready for review"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: task } = await soat.tasks.createTask({
  body: {
    project_id: PROJECT_ID,
    workflow_id: WORKFLOW_ID,
    title: 'Blog post: launch recap',
    payload: { topic: 'launch recap' },
  },
});

const { data: moved } = await soat.tasks.transitionTask({
  path: { task_id: task.id },
  body: { transition: 'to_review', note: 'ready for review' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
TASK_ID=$(curl -s -X POST "$SOAT_URL/api/v1/tasks" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","workflow_id":"'"$WORKFLOW_ID"'","title":"Blog post: launch recap","payload":{"topic":"launch recap"}}' | jq -r '.id')

curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"to_review","note":"ready for review"}'
```

</TabItem>
</Tabs>

### Fire an approval-gated transition

See [Approval-gated transitions](#approval-gated-transitions).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Parks instead of moving: the task now shows pending_transition.
soat transition-task --task-id "$TASK_ID" --transition publish

APPROVAL_ID=$(soat list-approvals --project-id "$PROJECT_ID" --status pending \
  | jq -r --arg t "$TASK_ID" '.[] | select(.task_id == $t) | .id' | head -n1)

# Approving fires the gated transition as the `approval` principal.
soat approve-approval --approval-id "$APPROVAL_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Parks instead of moving: parked.pending_transition === 'publish'.
const { data: parked } = await soat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'publish' },
});

const { data: pending } = await soat.approvals.listApprovals({
  query: { project_id: PROJECT_ID, status: 'pending' },
});
const gate = pending.find((a) => a.task_id === TASK_ID)!;

// Approving fires the gated transition as the `approval` principal.
await soat.approvals.approveApproval({ path: { approval_id: gate.id } });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"publish"}'

APPROVAL_ID=$(curl -s "$SOAT_URL/api/v1/approvals?project_id=$PROJECT_ID&status=pending" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r --arg t "$TASK_ID" '.[] | select(.task_id == $t) | .id' | head -n1)

curl -s -X POST "$SOAT_URL/api/v1/approvals/$APPROVAL_ID/approve" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

</TabItem>
</Tabs>

### Pause and resume a task's automation

See [Pausing a task](#pausing-a-task).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat pause-task --task-id "$TASK_ID" --reason "credit balance went negative"

# Lifts the pause and dispatches the current state's on_enter if it was suppressed.
soat resume-task --task-id "$TASK_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: paused, error } = await soat.tasks.pauseTask({
  path: { task_id: TASK_ID },
  body: { reason: 'credit balance went negative' },
});
if (error) throw new Error(JSON.stringify(error));

// paused.automation_status === 'paused' once a suppressed state is entered.
await soat.tasks.resumeTask({ path: { task_id: TASK_ID } });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/pause" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"credit balance went negative"}'

curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/resume" \
  -H "Authorization: Bearer $TOKEN"
```

</TabItem>
</Tabs>
