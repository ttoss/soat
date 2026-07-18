---
description: "Durable, stateful work items bound to a workflow — an entity that moves between states over time, including backward."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Tasks

A **task** is a durable, stateful work item bound to a [workflow](./workflows.md):
a current state, a mutable payload, and a full, audited transition history. It is
the **entity that lives** — the counterpart to an orchestration run, except it
does not terminate on its own and can revisit states.

> A support ticket that reopens. A lead that goes `qualified → negotiating →
> stalled → negotiating`. A kanban card dragged back a column. None of these fit
> a DAG — a task is the shape they need.

> See the [Permissions Reference](../permissions.md#tasks) for the IAM action
> strings for this module.

## Overview

You create a task against a workflow; it is placed in that workflow's `initial`
state and that state's `on_enter` automation fires. From then on, every state
change routes through the **transition** endpoint — the single path that enforces
guards and appends history. A task's `state` is **never directly writable**; only
a transition moves it.

The board is the whole point: `GET /tasks?workflow_id=…&state=…` is one column,
the workflow's states are the columns, and each task is a card — with **zero**
application-side state.

## Data Model

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

### Transition history

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

## Key Concepts

- **Single transition path.** Human, API, agent-via-MCP, and automation outcomes
  all call the same transition operation. A transition must exist in the workflow
  and be valid from the task's current state; its guard must pass.
- **Guards.** A transition's `guard` (JSON Logic over `{task, transition, actor}`)
  is evaluated **before** any state change. A false guard rejects the move with
  `TASK_GUARD_REJECTED` and leaves the task untouched.
- **Atomicity & conflicts.** The state change happens under a row lock;
  concurrent transitions on one task serialize. A transition that is no longer
  valid from the committed state — or a transition on a `closed` task — returns
  `TASK_TRANSITION_CONFLICT` (409).
- **Payload is working data.** `PATCH /tasks/{id}` updates `payload`, `title`, or
  `assignee` (validated against the workflow's `payload_schema`). Transitions are
  the audited contract; payload writes are not versioned.

## Error Codes

| Code                       | Status | When                                                            |
| -------------------------- | ------ | -------------------------------------------------------------- |
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

## Examples

### Create a task

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-task \
  --project-id "$PROJECT_ID" \
  --workflow-id "$WORKFLOW_ID" \
  --title "Blog post: launch recap" \
  --payload '{"topic":"launch recap"}'
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
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project_id":"'"$PROJECT_ID"'","workflow_id":"'"$WORKFLOW_ID"'","title":"Blog post: launch recap","payload":{"topic":"launch recap"}}'
```

</TabItem>
</Tabs>

### Fire a transition

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat transition-task --task-id "$TASK_ID" --transition to_review --note "ready for review"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: moved } = await soat.tasks.transitionTask({
  path: { task_id: TASK_ID },
  body: { transition: 'to_review', note: 'ready for review' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_URL/api/v1/tasks/$TASK_ID/transitions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"transition":"to_review","note":"ready for review"}'
```

</TabItem>
</Tabs>

## Related Tutorials

- [Write a Sonnet with a Workflow](/docs/tutorials/orchestrate-a-sonnet-with-workflows) — a task flows through agent-driven states and a human review, with a backward move a DAG would reject.
