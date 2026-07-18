---
description: "State-machine definitions (workflows) and the durable, stateful work items that live in them (tasks)."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Workflows & Tasks

Define a **state machine** — named states, transitions, guards, and per-state
automation (a **workflow**) — and run durable **tasks** through it that move
between states over time, including backward.

- A **workflow** is the versioned _definition_ (like an orchestration
  definition): states, transitions, guards, and automation.
- A **task** is a durable _instance_ bound to a workflow (like an orchestration
  run) — except it does not terminate on its own and can revisit states.

## Workflow or orchestration?

An **[orchestration](./orchestrations.md) is a pipeline that _ends_** — a
directed acyclic graph that runs forward and terminates. A **workflow is a state
graph a task _lives_ in** — a long-lived entity that moves between named states
over days or weeks, and can revisit them.

| You want… | Use |
| --- | --- |
| Statuses, transitions, guards, a kanban board, or an entity that revisits states | **Workflows & Tasks** (this module) |
| A deterministic, forward-only sequence of steps that runs and completes | **[Orchestrations](./orchestrations.md)** |

The two compose: when a task enters a state, that state may **dispatch** an
orchestration or an agent to do its work. A workflow never replaces a run — it
_drives_ one.

> A support ticket that reopens. A lead that goes `qualified → negotiating →
> stalled → negotiating`. A kanban card dragged back a column. None of these fit
> a DAG — a task is the shape they need.

> See the [Permissions Reference](../permissions.md#workflows) for the
> `workflows:` action strings and [#tasks](../permissions.md#tasks) for the
> `tasks:` action strings.

## Overview

A workflow's two lists are the whole model:

- **`states`** — the named columns of a board. Exactly one is `initial`; any
  number are `terminal` (entering one closes the task). A `kind: human` state
  never dispatches; the task parks there until a principal fires a transition.
  A state may declare `on_enter` automation (see [Automation](#per-state-automation-on_enter)).
- **`transitions`** — the named, directional moves between states. A transition
  lists the states it is valid `from` and the single state it moves `to`.
  Backward moves (`review → draft`) are just transitions — **cycles are the
  point, not an error**, which is exactly what an orchestration DAG rejects by
  design.

You create a task against a workflow; it is placed in that workflow's `initial`
state and that state's `on_enter` automation fires. From then on, every state
change — human, API, agent (via MCP), or automation outcome — routes through the
single **transition** operation, so guards and the audit trail can never be
bypassed. A task's `state` is **never directly writable**; only a transition
moves it.

The board is the whole point: `GET /tasks?workflow_id=…&state=…` is one column,
the workflow's states are the columns, and each task is a card — with **zero**
application-side state.

## Data Model

### Workflow

| Field            | Type            | Description                                        |
| ---------------- | --------------- | -------------------------------------------------- |
| `id`             | string          | Public identifier (`wfl_…`)                        |
| `project_id`     | string          | Owning project (hard security boundary)            |
| `name`           | string          | Human-readable name, unique per project            |
| `description`    | string \| null  | Optional description                               |
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
| `stalled_after` | integer \| null | _Reserved:_ seconds parked before a `tasks.stalled` event (Phase 3) |

#### Transition

| Field               | Type           | Description                                                        |
| ------------------- | -------------- | ----------------------------------------------------------------- |
| `name`              | string         | Unique within the workflow; the name a caller fires               |
| `from`              | string[]       | Source states this transition is valid from                       |
| `to`                | string         | The single destination state                                      |
| `guard`             | object \| null | [JSON Logic](https://jsonlogic.com) over `{task, transition, actor}`; a false result rejects the move with `TASK_GUARD_REJECTED` |
| `requires_approval` | boolean        | _Reserved:_ gate the transition behind an approval (Phase 3)      |

A transition not defined here **cannot be fired by anyone** — there is no
free-move escape hatch. Define an explicit any-state transition (listing every
state in `from`) if a workflow needs one.

### Task

| Field               | Type             | Description                                                              |
| ------------------- | ---------------- | ----------------------------------------------------------------------- |
| `id`                | string           | Public identifier (`task_…`)                                            |
| `project_id`        | string           | Owning project (hard security boundary)                                 |
| `workflow_id`       | string           | The workflow definition this task is bound to                           |
| `title`             | string           | Human-readable label                                                    |
| `state`             | string           | Current state name. Read-only — moved only via a transition             |
| `status`            | `open` \| `closed` | `closed` once the task enters a `terminal` state                      |
| `payload`           | object           | Mutable task data; input to guards and dispatch `input_mapping`s        |
| `assignee`          | string \| null   | Informational in v1 (user/actor public ID)                              |
| `active_dispatch`   | object \| null   | `{ kind, id, status }` of the current state's dispatch, if any          |
| `automation_status` | string \| null   | `running` \| `completed` \| `failed` for the current state's dispatch   |
| `entered_state_at`  | string           | When the task entered its current state                                 |
| `created_at`        | string           | ISO 8601 creation timestamp                                             |
| `updated_at`        | string           | ISO 8601 last-updated timestamp                                         |

#### Transition history

Every move appends one append-only `TaskTransition` record — the audited
contract for a task. `GET /tasks/{id}/history` returns them oldest-first.

| Field           | Type            | Description                                                        |
| --------------- | --------------- | ----------------------------------------------------------------- |
| `id`            | string          | Public identifier (`task_tr_…`)                                   |
| `task_id`       | string          | Owning task                                                        |
| `from_state`    | string \| null  | Source state (`null` on the initial placement)                    |
| `to_state`      | string          | Destination state                                                 |
| `transition`    | string \| null  | Transition name fired (`null` for the initial placement)          |
| `actor_kind`    | string          | `user` \| `api_key` \| `automation` \| `approval`                 |
| `actor_id`      | string \| null  | Principal or automation provenance                                |
| `generation_id` | string \| null  | The agent generation that caused the move, when automation-driven |
| `run_id`        | string \| null  | The orchestration run that caused the move, when automation-driven |
| `note`          | string \| null  | Optional reason supplied by the caller                            |
| `created_at`    | string          | ISO 8601 timestamp                                                |

## Per-state automation (`on_enter`)

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
      }
    },
    "on_complete": [
      { "when": { "==": [{ "var": "result.category" }, "simple"] }, "transition": "to_review" },
      { "when": true, "transition": "to_review" }
    ],
    "on_failure": null
  }
}
```

- **`dispatch`** — one agent (`kind: agent`, `agent_id`) or orchestration
  (`kind: orchestration`, `orchestration_id`). `input_mapping` is JSON Logic
  over `{task}` that resolves the dispatch input from the task payload — the same
  expression language orchestrations use.
- **`on_complete`** — labeled rules evaluated in order against `{task, result}`;
  the first match fires its transition **as the `automation` actor** (subject to
  the same guards). An agent dispatch exposes its generation output under
  `{result}`; an orchestration dispatch exposes its final run state. The result
  is also written to `task.payload.last_result` for downstream states. No rule
  matches → the task stays put with `automation_status: completed` and a
  `tasks.automation_unrouted` event fires (never silently stuck).
- **`on_failure`** — a transition to fire when the dispatch fails terminally.
  Omitted → the task stays in the state with `automation_status: failed` for a
  human to resolve.

Entering a state cancels any dispatch still running from the state the task is
leaving — task state is the source of truth (an entity that lives).

## Key Concepts

- **Single transition path.** Human, API, agent-via-MCP, and automation outcomes
  all call the same transition operation. A transition must exist in the workflow
  and be valid from the task's current state; its guard must pass.
- **Atomicity & conflicts.** The state change happens under a row lock;
  concurrent transitions on one task serialize. A transition that is no longer
  valid from the committed state — or a transition on a `closed` task — returns
  `TASK_TRANSITION_CONFLICT` (409).
- **Definition updates re-validate.** Structural changes (states/transitions)
  are validated on `PATCH`. Existing tasks in a state a new definition removes
  stay put but can only leave via transitions valid in the new definition — the
  definition is the sole authority at fire time.
- **Delete is guarded.** A workflow with one or more **open** tasks cannot be
  deleted (`WORKFLOW_HAS_OPEN_TASKS`).
- **Payload is working data.** `PATCH /tasks/{id}` updates `payload`, `title`, or
  `assignee` (validated against `payload_schema`). Transitions are the audited
  contract; payload writes are not versioned.

## Error Codes

| Code                       | Status | When                                                            |
| -------------------------- | ------ | -------------------------------------------------------------- |
| `WORKFLOW_NOT_FOUND`       | 404    | The workflow does not exist or is not accessible               |
| `WORKFLOW_VALIDATION_FAILED`| 400   | The workflow definition is invalid                             |
| `WORKFLOW_HAS_OPEN_TASKS`  | 409    | The workflow has open tasks and cannot be deleted              |
| `TASK_NOT_FOUND`           | 404    | The task does not exist or is not accessible                   |
| `TASK_PAYLOAD_INVALID`     | 400    | The payload violates the workflow's `payload_schema`           |
| `TASK_TRANSITION_NOT_FOUND`| 400    | The named transition does not exist in the workflow            |
| `TASK_GUARD_REJECTED`      | 400    | The transition guard evaluated to false                        |
| `TASK_TRANSITION_CONFLICT` | 409    | The transition is not valid from the current state, or the task is closed |

## Webhook events

| Event                        | When                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `tasks.created`              | A task is created and placed in its initial state        |
| `tasks.transitioned`         | A task moves between states                              |
| `tasks.closed`               | A task enters a terminal state                           |
| `tasks.automation_unrouted`  | A dispatch completed but no `on_complete` rule matched   |

## Related Tutorials

- [Write a Sonnet with a Workflow](/docs/tutorials/orchestrate-a-sonnet-with-workflows) — a task flows through agent-driven states and a human review, with a backward move a DAG would reject.

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
