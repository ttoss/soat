---
description: "Neither, an orchestration, or a workflow? Decide whether the work needs a graph at all, then compare SOAT's two automation models — a cyclic state machine a task lives in, and an acyclic pipeline that runs and ends — and see how they compose."
title: Choosing an Automation Model
---

# Choosing an Automation Model

SOAT has two ways to automate work that spans more than one step, and they are not
variations of each other — they have different topologies and different lifetimes.

- An **[orchestration](/docs/modules/orchestrations) is a pipeline that _ends_** — a
  directed acyclic graph that starts, flows forward through its nodes, and terminates.
- A **[workflow](/docs/modules/workflows) is a state graph a task _lives_ in** — a
  long-lived entity that moves between named states over days or weeks, and can move
  backward.

There is also a third answer, and it is the most common one:

| You want…                                                                          | Use                                             |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Steps you cannot enumerate in advance, with no fan-out, no human gate, and no wait that outlives the request | **[A single agent](/docs/modules/agents)** — no graph |
| A deterministic, forward-only sequence of steps that runs and completes             | **[Orchestrations](/docs/modules/orchestrations)** |
| Statuses, transitions, guards, a kanban board, or an entity that revisits states    | **[Workflows & Tasks](/docs/modules/workflows)**  |

> A support ticket that reopens. A lead that goes `qualified → negotiating → stalled →
> negotiating`. A kanban card dragged back a column. None of these fit a DAG — a task is
> the shape they need.

Neither module is a subset of the other. A workflow adds primitives a DAG cannot express;
an orchestration carries almost all of the execution machinery. The two sections below say
exactly which.

## Step 0 — you may need neither

Both models are the **graph** layer, and the graph is the layer to build last. As
[The Layers of an Agent System](/docs/agent-system-layers) puts it: harness first, loop
second, graph last — and last frequently means never. A pipeline drawn around a problem
the harness or the loop was going to solve anyway costs you a definition to version, a run
to inspect, and a state contract to keep wired, and buys nothing.

Reach for a single [agent](/docs/modules/agents) first. Its loop already sequences work
the graph layer would otherwise sequence for you, and three dials bound it:

| Dial | What it does |
| --- | --- |
| [`max_steps`](/docs/modules/agents#generation-loop) | Caps how many reasoning steps the loop may take (default `20`) |
| [`stop_conditions`](/docs/modules/agents#stop-conditions) | Ends the loop as soon as the model calls a named tool — the `hasToolCall` condition, enforced alongside `max_steps` |
| [`output_schema`](/docs/modules/agents#structured-output) | Makes the result a checked object rather than prose a downstream step must parse |

Escalate to a graph when — and only when — the work needs something an agent loop cannot
express:

| Signal | What only a graph gives you |
| --- | --- |
| **Steps run in parallel and rejoin** | [Parallel execution rounds](/docs/modules/orchestrations#parallel-execution) and [`activation_group` fan-in](/docs/modules/orchestrations#activation-groups-fan-in). An agent loop is sequential |
| **The branch must be auditable, not inferred** | A [`condition` node](/docs/modules/orchestrations#node-types) emits a label an edge selects on, and every attempt lands in [`node_executions`](/docs/modules/orchestrations#node-executions). A model choosing its own next step leaves no such record |
| **A human signs off mid-run** | [`human`](/docs/modules/orchestrations#human-nodes) and [`approval`](/docs/modules/orchestrations#approval-nodes) nodes park the run and resume it later |
| **The wait outlives the request** | [Durable background execution](/docs/modules/orchestrations#durable-background-execution) — `delay`, `poll`, and the `sleeping` status let a run span hours or days holding no connection open |
| **The entity revisits states over days** | A [workflow](/docs/modules/workflows) — see the rest of this page |

None of these is a reason to throw the agent away: an agent is a
[node type](/docs/modules/orchestrations#node-types), so a graph wraps the loop you
already have rather than replacing it.

## What starts them

Both are started the same way — by a client, or by a
[trigger](/docs/modules/triggers) that binds a starter to the target. Two of
those starters answer the same question differently, and the choice is worth
making deliberately:

- An **`event` trigger** subscribes to an internal platform event
  (`documents.ingested`, `agents.generation.completed`, an orchestration's own
  `emit_event`) and starts work the moment it happens. Use it when the work is a
  *reaction* to something the platform already knows about and promptness is the
  point. Delivery is best-effort and unordered, and the reactive edge is capped
  by a [causation depth guard](/docs/modules/triggers#loops-and-cost) so a cycle
  cannot run away.
- A **`schedule` trigger** runs on a cron cadence and is recovered from the
  database, so a firing missed while the server was down is coalesced into one
  catch-up rather than lost. Use it when the work is periodic, when it must not
  be dropped, or as the backstop under an event trigger whose target is
  idempotent.

## What only workflows have

| Capability                                                                                     | Why a DAG cannot do it                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Cycles** — `review → draft`, a card dragged back a column                                    | Graph validation rejects a cycle by design                                |
| **A long-lived entity** — a task never terminates on its own (`status: open` / `closed`)        | A run always drives toward a terminal node                                 |
| **Named transitions as the only mutation path**, with guards over `{task, transition, principal}` | A run advances by the edges the engine picks; there is nothing to fire     |
| **A board query** — [`GET /tasks?workflow_id=…&state=…`](/docs/api/tasks/list-tasks) is one column, with zero app-side state | —                                                                         |
| **Append-only transition history** with `principal_kind` (`user`/`api_key`/`automation`/`approval`) | `node_executions` records execution, not who moved what                   |
| **Caller-owned mutable `payload`** (shallow-merged on `PATCH`, validated by `payload_schema`)   | A run's `state` is engine-owned                                           |
| **Approval-gated _transitions_** (`requires_approval` parks the move itself)                    | An `approval` node gates a tool call, not a state change                   |
| **Stall detection** — `stalled_after` emits `tasks.stalled`, re-armed on the next transition    | A run has no "sat here too long" concept                                  |
| **Alternate entry points** — create a task directly in a named state                            | —                                                                         |

## What only orchestrations have

A workflow state's `on_enter` dispatches **at most one** thing — one agent generation or
one orchestration run. Everything below therefore lives on the orchestration side, and a
workflow reaches it by dispatching a run:

- **Every node type** — `agent`, `tool`, `transform`, `knowledge`, `memory_write`,
  `condition`, `human`, `approval`, `loop`, `poll`, `delay`, `emit_event`, `webhook`,
  `sub_orchestration` — plus parallel execution rounds, `activation_group` fan-in, branch
  labels, and nested sub-graphs.
- **Durable background execution** — a queue with leases and a reaper, `postgres` and
  `sqs` drivers, concurrency caps, queue metrics, the `sleeping` / `awaiting_input` /
  `expired` / `cancelled` statuses, and resume/cancel.
- **Per-node retry** with `fixed` or `exponential` backoff and a delay ceiling. (A
  workflow's `retry` is a simpler per-dispatch policy for one state.)
- **The `state` / `artifacts` / `nodes.<id>` namespaces**, `input_schema` and
  `state_schema`, and a `node_executions` record per attempt.
- **Usage roll-up** — tokens and cost summed across every metered generation in the run,
  plus a linked trace.
- **Guardrail interception** on tool nodes.

## How they compose

The two compose in both directions, and a state that dispatches a run is the normal case:
a workflow never replaces a run, it _drives_ one.

**Workflow → orchestration.** A state's `on_enter` names an `orchestration_id` and
resolves the run input from the task with an `input_mapping`. See
[Per-state automation](/docs/modules/workflows#per-state-automation-on_enter).

**Orchestration → workflow.** A graph moves a task on with an ordinary `tool` node bound
to a [`builtin` tool](/docs/modules/tools#builtin) for `create-task` or `transition-task`. There
is no dedicated node type, and none is needed:

```json
{
  "id": "advance",
  "type": "tool",
  "tool_id": "tool_transition",
  "operation_id": "transition-task",
  "input_mapping": {
    "task_id": { "var": "input.task_id" },
    "transition": "finish"
  }
}
```

A dispatched **agent** does the same thing with a `builtin` tool of its own.

Both kinds of dispatch act as the principal that started the chain — the person or key
that created the task or fired the transition — and each automated hop inherits that
identity, so a chain of states keeps acting as whoever set it going rather than decaying
to no principal at the second state. See
[Run identity](/docs/modules/orchestrations#durable-background-execution).

### Two rules for the composed edge

**Keep the orchestration → workflow edge fire-and-forget.** A graph that instead waits for
a task to reach some state inverts the two lifetimes — a run is bounded and holds a lease
and a queue slot, while a task lives for days and can move backward. Let the run end and
let the task's own state machine carry things forward.

**Bound the cycle yourself.** A state whose orchestration transitions the task back into
that same state is a cycle no validator can see: cycle detection is per-graph, and
workflow cycles are deliberate. The task engine bounds it with an
[automation chain budget](/docs/modules/workflows#the-automation-chain-budget) and
refuses the hop that would exceed it — but the budget is a backstop, not a design.
Reaching it means a loop is running unattended, which is worth an alert rather than a
shrug. Bound the cycle in the graph you write; let the budget catch the case you missed.

## What the two share

Both modules are built on the same platform machinery, in the same shape:

- **Versioning with instance pinning** — a definition write archives a version, and a task
  or run executes the version it entered on. See
  [workflow versioning](/docs/modules/workflows#versioning) and
  [orchestration versioning](/docs/modules/orchestrations#versioning).
- **Declarative deployment** — both are [formation](/docs/modules/formations) resource
  types, so a workflow, the orchestrations its states dispatch, and the agents those
  graphs call all deploy as one stack.
- **[JSON Logic](https://jsonlogic.com) expressions** for `input_mapping`, guards, and
  conditions.
- **Webhook events** for lifecycle changes, and the same project-scoped
  [IAM](/docs/modules/iam) enforcement.
