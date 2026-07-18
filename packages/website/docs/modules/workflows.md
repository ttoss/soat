---
description: "State-machine definitions — named states, transitions, guards, and per-state automation — that tasks live in."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Workflows

Define a **state machine** — named states, allowed transitions, guards, and
per-state automation — that [tasks](./tasks.md) move through over time,
including backward.

## Workflow or orchestration?

An **[orchestration](./orchestrations.md) is a pipeline that _ends_** — a
directed acyclic graph that runs forward and terminates. A **workflow is a state
graph a task _lives_ in** — a long-lived entity that moves between named states
over days or weeks, and can revisit them.

| You want… | Use |
| --- | --- |
| Statuses, transitions, guards, a kanban board, or an entity that revisits states | **Workflows** (this module) |
| A deterministic, forward-only sequence of steps that runs and completes | **[Orchestrations](./orchestrations.md)** |

The two compose: when a task enters a state, that state may **dispatch** an
orchestration or an agent to do its work. A workflow never replaces a run — it
_drives_ one.

> See the [Permissions Reference](../permissions.md#workflows) for the IAM
> action strings for this module.

## Overview

A workflow is a versioned _definition_ — like an orchestration definition, it
carries config and no runtime state. Its two lists are the whole model:

- **`states`** — the named columns of a board. Exactly one is `initial`; any
  number are `terminal` (entering one closes the task). A `kind: human` state
  never dispatches; the task parks there until a principal fires a transition.
  A state may declare `on_enter` automation (see [Automation](#per-state-automation-on_enter)).
- **`transitions`** — the named, directional moves between states. A transition
  lists the states it is valid `from` and the single state it moves `to`.
  Backward moves (`review → draft`) are just transitions — **cycles are the
  point, not an error**, which is exactly what an orchestration DAG rejects by
  design.

Every state change on a task — human, API, agent (via MCP), or automation
outcome — routes through the single **transition** operation, so guards and the
audit trail can never be bypassed.

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

### State

| Field           | Type            | Description                                                          |
| --------------- | --------------- | ------------------------------------------------------------------- |
| `name`          | string          | Unique within the workflow                                          |
| `initial`       | boolean         | Exactly one state must be `true` — where new tasks start            |
| `terminal`      | boolean         | Entering a terminal state closes the task (`status: closed`)        |
| `kind`          | string \| null  | `human` marks a parking state that never dispatches                 |
| `on_enter`      | object \| null  | Automation fired when a task enters this state (see below)          |
| `stalled_after` | integer \| null | _Reserved:_ seconds parked before a `tasks.stalled` event (Phase 3) |

### Transition

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

- **Definition updates re-validate.** Structural changes (states/transitions)
  are validated on `PATCH`. Existing tasks in a state a new definition removes
  stay put but can only leave via transitions valid in the new definition — the
  definition is the sole authority at fire time.
- **Delete is guarded.** A workflow with one or more **open** tasks cannot be
  deleted (`WORKFLOW_HAS_OPEN_TASKS`).
- **`payload_schema`** is a lightweight JSON Schema (required keys + primitive
  types) validated whenever a task's payload is created or patched.

## Webhook events

`tasks.created`, `tasks.transitioned`, `tasks.closed`, and
`tasks.automation_unrouted` are emitted as tasks move (see [Tasks](./tasks.md)).

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

### List workflows

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-workflows --project-id "$PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: workflows } = await soat.workflows.listWorkflows({
  query: { project_id: PROJECT_ID },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_URL/api/v1/workflows?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

</TabItem>
</Tabs>

## Related Tutorials

- [Write a Sonnet with a Workflow](/docs/tutorials/orchestrate-a-sonnet-with-workflows) — a task flows through agent-driven states and a human review, with a backward move a DAG would reject.
