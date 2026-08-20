---
description: "State-machine definitions (workflows) and the durable, stateful work items that live in them (tasks)."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Workflows & Tasks

Define a **state machine** — named states, transitions, guards, and per-state
automation (a **workflow**) — and run durable **tasks** through it that move
between states over time, including backward.

## Overview

A **workflow** is the versioned _definition_; a **task** is a durable _instance_
bound to it that does not terminate on its own and can revisit states. Where an
[orchestration](./orchestrations.md) is a forward-only DAG that runs and ends, a
workflow is a state graph a task _lives_ in — statuses, guarded transitions, a
kanban board, backward moves. The two compose: a state may **dispatch** an
orchestration, an agent, or a single tool call to do its work. See
[Choosing an Automation Model](/docs/advanced/choosing-an-automation-model)
for the full comparison and composition patterns.

A workflow's two lists are the whole model:

- **`states`** — the named columns of a board. Exactly one is `initial`; any
  number are `terminal` (entering one closes the task). A `kind: human` state
  never dispatches; the task parks there until a principal fires a transition.
  A state may declare `on_enter` automation (see [Per-state automation](#per-state-automation-on_enter)).
- **`transitions`** — the named, directional moves between states, each valid
  `from` listed states `to` a single destination. Backward moves are just
  transitions — cycles are the point, not an error.

Creating a task places it in the workflow's `initial` state (or a named `state`
— see [Alternate entry points](#alternate-entry-points)) and fires that state's
`on_enter`. From then on, every state change — human, API, agent (via MCP), or
automation outcome — routes through the single **transition** operation, so
guards and the audit trail can never be bypassed. A task's `state` is never
directly writable. The board is the point: [`GET /tasks?workflow_id=…&state=…`](/docs/api/tasks/list-tasks)
is one column, with zero application-side state.

> See the [Permissions Reference](../permissions.md#workflows) for the
> `workflows:` action strings and [#tasks](../permissions.md#tasks) for the
> `tasks:` action strings.

## Related Tutorials

- [Write a Sonnet with a Workflow](/docs/tutorials/orchestrate-a-sonnet-with-workflows) — a task flows through agent-driven states and a human review, with a backward move a DAG would reject.
- [Close the Monthly Books - Step 8 (Define the close period as a workflow)](/docs/tutorials/close-the-monthly-books#step-8--define-the-close-period-as-a-workflow) — a guarded, approval-gated transition alongside an orchestration that does each state's work.

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

A transition not defined here cannot be fired by anyone — there is no free-move
escape hatch. Define an explicit any-state transition (listing every state in
`from`) if a workflow needs one.

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
| `last_result`       | any \| null      | Server-owned, read-only: the result of the current state's last completed dispatch, overwritten on every dispatch. Guards read it as `task.last_result` |
| `assignee`          | string \| null   | Informational in v1 (a user or actor public ID; not interpreted by the engine) |
| `active_dispatch`   | object \| null   | `{ kind, id, status }` of the current state's dispatch, if any — plus `attempt` while a `retry` policy is in effect. `kind` is `generation`, `orchestration_run` or `tool_call`; a `tool_call` always carries a null `id`, since a direct tool call leaves no addressable record |
| `automation_status` | string \| null   | `running` \| `completed` \| `failed` \| `unrouted` for the current state's dispatch |
| `automation_chain_depth` | integer     | Server-owned, read-only: how many machine-driven transitions have run back-to-back with no outside intervention. Reset to `0` by any move a person, a plain API key, or an approval resolution makes. See [The automation chain budget](#the-automation-chain-budget) |
| `pending_transition`| string \| null   | Name of a `requires_approval` transition parked awaiting a human decision; null otherwise |
| `tool_context`      | object           | **Write-only.** Caller context for the task's automation dispatches, accepted on `create-task` and `transition-task` and never returned by a read. See [Dispatch tool context](#dispatch-tool-context) |
| `entered_state_at`  | string           | When the task entered its current state                                 |
| `created_at`        | string           | ISO 8601 creation timestamp                                             |
| `updated_at`        | string           | ISO 8601 last-updated timestamp                                         |

#### Transition history

Every move appends one append-only `TaskTransition` record — the audited
contract for a task. [`GET /tasks/{id}/history`](/docs/api/tasks/get-task-history) returns them oldest-first.

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

- **Single transition path.** Human, API, agent-via-MCP, and automation outcomes
  all call the same transition operation. A transition must exist in the workflow
  and be valid from the task's current state; its guard must pass.
- **Atomicity & conflicts.** The state change happens under a row lock;
  concurrent transitions on one task serialize. A transition that is no longer
  valid from the committed state — or a transition on a `closed` task — returns
  `TASK_TRANSITION_CONFLICT` (409). The post-dispatch write (`active_dispatch`,
  `automation_status`, `last_result`, `payload_writes`) re-validates under the
  same lock; a stale write is discarded instead of clobbering the new state.
- **Delete is guarded.** A workflow with one or more **open** tasks cannot be
  deleted (`WORKFLOW_HAS_OPEN_TASKS`). Once every task is closed (terminal),
  deleting the workflow also removes those closed tasks and their transition
  history.
- **Payload is working data.** [`PATCH /tasks/{id}`](/docs/api/tasks/update-task) updates `payload`, `title`, or
  `assignee`. `payload` is **shallow-merged** over the current payload (keys the
  request omits are kept) and validated against `payload_schema`. The payload is
  100% caller-owned; the automation result lives in the read-only `last_result`
  field, which no patch can reach — a guard on `task.last_result` is only ever
  satisfied by a value an automation wrote. Transitions are the audited
  contract; payload writes are not versioned.

### Per-state automation (`on_enter`)

A state's `on_enter` dispatches **at most one** agent generation or orchestration
run when a task enters it, and routes the outcome back into a transition:

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

- **`dispatch`** — one agent (`kind: agent`, `agent_id`), orchestration
  (`kind: orchestration`, `orchestration_id`) or tool call (`kind: tool`,
  `tool_id`, optional `operation_id` to select an operation on a
  multi-operation tool). `input_mapping` is JSON Logic
  over `{task}` resolving the dispatch input from the task payload — for a
  `tool` dispatch it resolves the tool's arguments.
  `payload_writes` (optional) is JSON Logic over `{task, result}`, written into
  named `task.payload` keys atomically with `last_result` when the dispatch
  completes — a named, deterministic channel that survives past the one hop
  `last_result` lives. Each write is a raw overwrite of its key, so in a loop
  a value from an earlier pass lingers until the state dispatches again.
- **`on_complete`** — labeled rules evaluated in order against `{task, result}`;
  the first match fires its transition **as the `automation` principal**
  (subject to the same guards). An agent dispatch exposes its generation output
  under `{result}`; an orchestration dispatch exposes its final run state; a
  tool dispatch exposes the tool's own return value. The
  result is also written to the server-owned `task.last_result`. No rule
  matches → the task stays put with `automation_status: completed` and a
  `tasks.automation_unrouted` event fires. A matched rule whose transition is
  rejected (guard fails for `automation`, or a concurrent move invalidated it)
  → the task stays put with `automation_status: unrouted` and a
  `tasks.automation_rejected` event fires (carrying the matched `transition`
  and the rejection `errorCode`) — never silently stuck.
- **`retry`** (optional) — a retry policy for the dispatch's **execution**
  failures, never for `on_complete` routing. `max_attempts` counts the first
  attempt (1–10); the delay before attempt `n` is
  `backoff_seconds * backoff_multiplier^(n - 2)` (defaults: 0, 1). `on_failure`
  — or the parked `automation_status: failed` — fires only after the last
  attempt. If the task leaves the state between attempts, the remaining ones
  are abandoned. Each attempt is recorded as `active_dispatch.attempt`, and
  every retried failure emits a `tasks.automation_retrying` event (carrying
  `attempt`, `max_attempts`, the error, and the failed
  `generation_id`/`orchestration_run_id`).
- **`on_failure`** — a transition to fire when the dispatch fails terminally.
  Omitted → the task stays in the state with `automation_status: failed` for a
  human to resolve.

Entering a state cancels any dispatch still running from the state the task is
leaving — including a genuinely in-flight orchestration run — because task state
is the source of truth.

#### Tool dispatch

A state whose work is a single tool call dispatches it directly, with no
orchestration in between:

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

`input_mapping` resolves the tool's arguments from the task context, and the
tool's return value becomes `{result}` and `task.last_result`. The call is
adjudicated by the **same guardrails** as the identical call made from an
orchestration `tool` node — a workflow dispatch is not a way around them — and
is recorded in the activity feed the same way.

Because a tool call settles within the dispatch, there is nothing to poll: the
move is recorded with `active_dispatch.kind: tool_call` and a null `id` (a tool
call leaves no addressable record), and the transition it causes carries
`tool_id` as its provenance.

Two cases belong behind an **orchestration** dispatch instead, and fail a `tool`
dispatch with `TOOL_DISPATCH_FAILED` rather than pretending to work:

- a tool a guardrail routes to **human approval** (class C) — a task dispatch has
  no run to park and resume;
- a call a guardrail **blocks** (class D, or a class-B tripwire) — the call never
  ran, so it is a dispatch failure, routable through `on_failure`.

#### Waiting, polling, and multi-step work

`on_enter` dispatches **one** thing. When a state needs to wait a fixed
duration, repeat a call until a condition holds, or run several steps, dispatch
an **orchestration** and put the work in its graph — `delay`, `poll`, and the
rest of the [node types](./orchestrations.md) are already there, and a task
dispatch deliberately starts the run in durable mode so those waits are owned by
the background scheduler rather than held open in a request:

```json
{
  "name": "awaiting_settlement",
  "on_enter": {
    "dispatch": { "kind": "orchestration", "orchestration_id": "orc_..." },
    "on_complete": [{ "when": true, "transition": "to_settled" }]
  }
}
```

The run parks as `sleeping` for the length of the wait and resumes on its own;
the task sits in the state with `automation_status: running` until the run
settles, then routes through `on_complete` / `on_failure` as usual. There is no
`kind: delay` or `kind: poll` — a one-node orchestration is the supported way to
express it.

#### Recovery after a restart

The run behind a dispatch is durable, but the wait for its outcome is not: it is
held in the process that started it. If the server restarts while a dispatch is
outstanding — most plausibly while an orchestration run is `sleeping` through a
long `delay` or `poll` interval — the run still finishes on the scheduler, and a
background reconciler routes the task when it does.

The reconciler only considers a dispatch that has read `running` for longer than
a grace window (`TASKS_DISPATCH_RECONCILE_GRACE_MS`, default `60000`), so a
healthy in-process hand-off is never raced. The recovered outcome is
indistinguishable from a live one: the same `on_complete` / `on_failure` rules
fire, as the same `automation` principal, with the run recorded as the move's
cause.

Dispatches of `kind: agent` are not reconciled — a generation parked in
`requires_action` awaiting client tool outputs is legitimately outstanding and
must not be routed as if it had settled.

### Versioning

A workflow's state machine is versioned by the same append-only archive that
backs [agent versions](./agents.md#versioning-and-staged-rollout),
[guardrail versions](./guardrails.md#versioning) and
[orchestration versions](./orchestrations.md#versioning). Version 1 is written
on create, and every subsequent write that **changes** the definition
increments `version` and archives it as a `WorkflowVersion`. The versioned
surface is `states`, `transitions` and `payload_schema`.

**A task runs on the version it entered on.** [`POST /tasks`](/docs/api/tasks/create-task) stamps the
workflow's current `version` onto the task as `workflow_version`, and every
later read of the definition — validating a transition, parking an approval
gate, validating a payload patch — resolves it from that version. Editing a
workflow never re-shapes a task already in flight; the live columns are a
draft for tasks created from now on.

Three writes archive nothing: a metadata-only edit (`name`, `description`);
re-writing the definition the workflow already holds (compared structurally);
restoring the version that is already live. `version_label` on a create or
update annotates the version that write archives; labelling a change is never
itself a change.

| Operation | Endpoint |
| --- | --- |
| List versions, newest first | [`GET /api/v1/workflows/{workflow_id}/versions`](/docs/api/workflows/list-workflow-versions) |
| Fetch one version | [`GET /api/v1/workflows/{workflow_id}/versions/{version}`](/docs/api/workflows/get-workflow-version) |
| Roll back to a version | [`POST /api/v1/workflows/{workflow_id}/versions/{version}/restore`](/docs/api/workflows/restore-workflow-version) |

**Restore appends, it does not rewind.** Restoring v1 of a workflow at v2
writes v1's definition back as **v3**; a task pinned to v2 still runs on the
machine it entered on. Only the definition rolls back — `name` and
`description` are untouched. A restored definition goes through the same
validation as an authored one, including resolving every `on_enter` dispatch
target, so restoring a version whose agent or orchestration has since been
deleted fails with `WORKFLOW_VALIDATION_FAILED` (400).

### Alternate entry points

[`POST /tasks`](/docs/api/tasks/create-task) accepts an optional `state`, naming a declared state to create
the task in directly instead of the `initial` state. Entering the named state
behaves exactly like arriving via a transition — `entered_state_at` is set,
`on_enter` fires, the stall clock arms — and history records the placement as
a single entry (`from_state: null`, `transition: null`). This lets a caller
that already knows which state and payload a task belongs at start it there
deterministically. An unknown `state` name is rejected with
`TASK_STATE_NOT_FOUND` (400).

### Approval-gated transitions

A transition with `requires_approval: true` is a **human gate**. Firing it (by
a user, API key, or automation outcome) does **not** move the task — it parks a
pending [ApprovalItem](./approvals.md) (`origin: task_transition`, carrying the
`task_id` and `task_transition`) and returns the task with `pending_transition`
set. No other transition may fire while the gate is open
(`TASK_TRANSITION_CONFLICT`, 409); one gate at a time per task.

Resolve the gate through the standard [approvals](./approvals.md) endpoints:

- **Approve** → the transition fires **as the `approval` principal** through
  the same single transition path. Its guard is **re-evaluated at resolution
  time**; if the move is no longer valid, the gate is cleared and a
  `tasks.approval_failed` event fires carrying the `transition` and
  `errorCode`.
- **Reject** → the gate is cleared and a note is appended to history
  (`principal_kind: approval`, `transition: null`). The task never moved.
- **Expire** → the approvals module's expiry sweeper clears the gate and
  appends an expiry note to history.

### Dispatch tool context

A task's automations are a generation entry point like any other, so they can
carry a [`tool_context`](../advanced/tool-context.md) — a flat
`Record<string, string>` forwarded as context headers on every `http`, `mcp`
and `builtin` tool call the task's dispatches make. It reaches both dispatch
kinds: an `agent` dispatch's generation, and an `orchestration` dispatch's run
(which carries it to every node and child run — see
[Run Tool Context](./orchestrations.md#run-tool-context)).

**It attaches per move** — creation is the first move:

| Request | Effect on the stored bag |
| --- | --- |
| `create-task --tool-context '{…}'` | Sets it. This is what the entry state's `on_enter` runs with |
| `transition-task --tool-context '{…}'` | **Replaces** it wholesale |
| `transition-task` with no `tool_context` | **Keeps** the current one |
| `transition-task --tool-context '{}'` | Clears it, without closing the task |
| Any transition into a `terminal` state | Cleared — a closed task holds no credential |

The credential a dispatch runs with belongs to whoever last moved the task.
Moves that supply no bag preserve it: automated hops (`on_complete` /
`on_failure` routing), `retry` attempts (identical across attempts), and
approval resolutions (the bag the *gated* move supplied is stored when the
gate parks and used when it resolves). A [stall](#stall-detection) is an
event, not a move, and leaves it untouched.

The reserved identity keys are stripped and re-derived server-side, and an
invalid key is rejected with `INVALID_TOOL_CONTEXT_KEY` (400) — see
[Validation](../advanced/tool-context.md#validation). **The bag is
write-only**: a task never returns its `tool_context`, since a task is
long-lived and read by everyone who can see the board. Confine a key to the
tools that need it with
[`context_keys`](./tools.md#scoping-which-context-keys-reach-a-tool).

### Stall detection

A state may declare `stalled_after` (seconds). A background sweeper emits a
`tasks.stalled` webhook event when an **open** task has sat in that state
longer than the threshold. It is an **event, not a transition** — the task
does not move; routing on a stall stays the author's choice via a webhook or
trigger. The event fires once per stall episode and is re-armed on the next
transition.

### The automation chain budget

Cycles are healthy; a cycle that turns entirely on its own — a state
dispatches, the outcome routes the task back in, it dispatches again, nobody
in the loop — is not. The task engine bounds the **chain**: every task carries
an `automation_chain_depth`, and a transition either increments it or resets
it to zero:

| The move | Effect |
| --- | --- |
| A dispatch outcome routed through `on_complete` / `on_failure` (the `automation` principal) | increments |
| A `transition-task` call from a dispatched run or agent, made with its run-as token | increments |
| A person, a plain API key, or an approval resolution | resets to `0` |

Once the depth would exceed the limit (`TASK_AUTOMATION_CHAIN_LIMIT`, default
`50`), the transition is refused with `TASK_AUTOMATION_CHAIN_LIMIT` —
**before** the state change, so the next `on_enter` never fires. The task
parks with `automation_status: unrouted` and a `tasks.automation_rejected`
event fires. A dispatched run or agent is recognized by its
[run-as token](./orchestrations.md#durable-background-execution), not its
principal. Any human touch starts the budget over, so a task that revisits
states for months is bounded only by how far it can travel untouched.

### Deploying as a formation

A workflow is a [formation](./formations.md) resource type (`workflow`), so it
deploys declaratively alongside the agents and orchestrations its states
dispatch. The resource `properties` mirror the REST body — `name`,
`description`, `states`, `transitions`, `payload_schema` — and an `on_enter`
dispatch's `agent_id` / `orchestration_id` accept `{ "ref": "LogicalId" }`
expressions.

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

Firing a `requires_approval` transition parks a pending approval; approving it
applies the move. See [Approvals](./approvals.md) for the resolution endpoints.

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
