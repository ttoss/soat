# PRD: Workflows & Tasks (Stateful Work Items)

- **Status:** Draft v1
- **Area:** Execution models — the stateful-entity layer between orchestrations and conversations
- **Consumes:** agents (generation dispatch), orchestrations (run dispatch), approvals (gated transitions), triggers/webhooks (event surface), IAM (permissions)
- **Feeds:** kanban/board UIs, activity/audit surfaces, usage metering

---

## 0. Problem statement

SOAT has two execution models today:

1. **Orchestrations** — deterministic, finite, forward-only DAGs. A run starts,
   flows through nodes, and ends. Cycles are rejected by validation
   (`orchestrationValidation.ts`), by design: a DAG models a *process that
   terminates*.
2. **Conversations / sessions / generations** — open-ended, LLM-driven
   interaction with no defined structure.

What is missing is the shape most operational work actually has: a
**long-lived entity that moves between named states over days or weeks, driven
by a mix of agents and humans, including backward**. A support ticket that
reopens. A lead that goes `qualified → negotiating → stalled → negotiating`. A
document that bounces between `draft` and `legal-review` four times. A kanban
card dragged back a column.

None of these fit a DAG — the cycle ban is the boundary of that model, not a
missing feature. And none fit a conversation. Users who need this today must
build their own state table, their own transition rules, their own
agent-dispatch glue, and their own audit trail outside SOAT — rebuilding ~70%
of the platform's value (durability, tracing, permissions, webhooks) per
application.

**One-line boundary rule** (this must stay crisp in docs and API design):

> An **orchestration** is a *process that ends*. A **task** is an *entity that
> lives*. When a task enters a state, it may *dispatch* an orchestration or an
> agent to do that state's work — the two models compose, they do not compete.

---

## 1. Module architecture

Two resources, one module:

- **Workflow** — the state-machine *definition*: named states, allowed
  transitions, guards, and per-state automation. Analogous to an
  `Orchestration` (definition) — versioned config, no runtime state.
- **Task** — a durable *instance* bound to a workflow: current state, payload,
  assignment, and a full transition history. Analogous to an
  `OrchestrationRun`, except it does not terminate on its own and can revisit
  states.

```
                 ┌──────────────────────────────────────────┐
  transition     │            Workflows module              │      dispatch
  producers      │                                          │      targets
                 │  Workflow (states, transitions, guards,  │
 ┌────────────┐  │            on_enter automation)          │  ┌──────────────┐
 │ REST/MCP   │─▶│                                          │─▶│ agent        │
 │ (human/API)│  │  Task (state, payload, history)          │  │ generation   │
 └────────────┘  │                                          │  └──────────────┘
 ┌────────────┐  │  transitionTask(id, transition):         │  ┌──────────────┐
 │ automation │─▶│    guard check → state change →          │─▶│ orchestration│
 │ outcome    │  │    history append → on_enter dispatch →  │  │ run          │
 └────────────┘  │    webhook events                        │  └──────────────┘
 ┌────────────┐  │                                          │  ┌──────────────┐
 │ approvals  │─▶│  stall sweeper (SLA timers)              │─▶│ webhooks     │
 └────────────┘  └──────────────────────────────────────────┘  └──────────────┘
```

The core exposes one internal operation everything routes through:

- **`transitionTask(args)`** — validates the transition exists in the
  workflow, evaluates the guard (JSON Logic over `{task, transition, actor}`),
  applies the state change atomically, appends a `TaskTransition` history
  record, fires `on_enter` automation for the new state, and emits
  `tasks.transitioned`. All producers — human via REST, agent via MCP,
  automation callback, approval resolution — go through this single path, so
  guards and audit can never be bypassed.

---

## 2. Why a module (and not sugar over orchestrations)

Evaluated alternatives:

| Alternative | Why it falls short |
|---|---|
| Model the board as one orchestration | Cycles are (correctly) rejected; no mutable "current state"; a run terminates |
| `loop` node around rework cycles | Bounded iteration inside one run; cannot model an entity re-entering a state weeks later, or human-driven backward moves |
| User-owned status table + triggers + orchestration runs | Rebuilds guards, history, dispatch glue, and permissions per application; no shared audit or MCP surface |
| Tags on existing resources (e.g. session/actor tags) | No transition semantics, no guards, no automation, no history |

The module's value is concentrated in what the workarounds cannot share:
transition guards enforced server-side, per-state dispatch wired to agents and
orchestrations, human-in-the-loop states with SLA timers, and one audit trail.

**Explicit non-goals (v1)** — this is infrastructure, not a project-management
product:

- No swimlanes, WIP limits, due-date calendars, comments, attachments,
  card ordering, or board layout. A kanban UI is a *view over* this module
  (columns = states, cards = tasks); it lives in `@soat/app` or user code.
- No per-task ACLs or assignment enforcement (`assignee` is informational
  in v1).
- No cron-style time-based transitions (compose with the existing triggers
  module instead); the only timer in v1 is the stall/SLA timer (§6).

---

## 3. Implementation phases

### Phase 1 — Core state machine (definitions, tasks, transitions, history)

**Deliverables:**

- `Workflow` and `Task` models (`wfl_` / `task_` prefixes) with lib module
  `src/lib/workflows.ts` (all DB access) and `src/lib/tasks.ts`.
- Workflow validation on create/update (§5): unique state names, transitions
  reference existing states, exactly one `initial: true` state, guards are
  well-formed JSON Logic. Mirrors `assertOrchestrationValid` in shape.
- `transitionTask` core with guard evaluation and atomic state change
  (row-level lock; concurrent transitions on one task serialize, the loser
  re-validates against the new state and fails with
  `TASK_TRANSITION_CONFLICT` if its transition is no longer valid).
- `TaskTransition` append-only history.
- REST CRUD + transition endpoint, OpenAPI specs, permissions, webhook events
  (`tasks.created`, `tasks.transitioned`, `tasks.closed`).

**Unlock:** durable, guarded, auditable work items — usable immediately with
human/API-driven transitions (a functional kanban backend with no automation).

### Phase 2 — Per-state automation (`on_enter` dispatch)

**Deliverables:**

- `on_enter` automation on a state (§5): dispatch an **agent generation** or
  an **orchestration run** when a task enters the state, with `input_mapping`
  (JSON Logic over `{task}`) resolving the dispatch input from the task
  payload — the same expression language orchestrations use.
- Outcome routing: `on_complete` maps the automation result to a follow-up
  transition via labeled rules (first match wins), mirroring how `condition`
  edges route in orchestrations. `on_failure` names a transition to fire when
  the dispatch fails terminally; when omitted the task stays in the state
  with `automation_status: failed` for a human to resolve.
- Automation provenance on the task (`active_dispatch`: kind, id, status) and
  on the history record (which generation/run caused a transition).
- Re-entrancy rule: at most one active dispatch per task; entering a state
  while a prior dispatch is still running cancels it (task state is the
  source of truth, matching the "entity that lives" semantics).

**Unlock:** the agentic kanban — cards advance themselves; agents do each
column's work; humans intervene only where the workflow says so.

### Phase 3 — Human-in-the-loop states, approvals, SLA timers

**Deliverables:**

- `kind: human` states: no dispatch; the task parks until a principal fires a
  transition (the state-machine counterpart of the orchestration `human`
  node).
- Approval-gated transitions: a transition may declare
  `requires_approval: true`; firing it emits an `ApprovalItem` through the
  existing approvals module and completes/aborts on resolution — reusing
  emit/resolve rather than duplicating queue machinery (per the approvals
  PRD's producer model).
- `stalled_after` (seconds) per state: a scheduler sweeper (reusing the
  orchestration scheduler cadence) emits `tasks.stalled` for tasks parked past
  the threshold — an event, not an automatic transition; routing on stall is
  the workflow author's choice via webhook/trigger composition.

**Unlock:** manage-by-exception boards — agents propose, humans gate, stale
cards surface themselves.

### Phase 4 — Formation resource + app view (future)

- `workflowsFormationModule` + `WorkflowResourceProperties` in
  `formations.yaml` so workflows deploy declaratively like other resources.
- A generic board view in `@soat/app` rendering any workflow as columns.
  Deferred until the API stabilizes; explicitly not required for v1 value.

---

## 4. Data models

### Workflow

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `wfl_` prefix |
| `project_id` | string | Owning project |
| `name` | string | Unique per project |
| `description` | string \| null | Human-readable purpose |
| `states` | array | State definitions (§5) |
| `transitions` | array | Allowed moves (§5) |
| `payload_schema` | object \| null | Optional JSON Schema for task payloads |
| `created_at` / `updated_at` | string | Timestamps |

### Task

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `task_` prefix |
| `project_id` | string | Owning project |
| `workflow_id` | string | Binding to the definition |
| `title` | string | Human-readable label |
| `state` | string | Current state name |
| `status` | string | `open` \| `closed` (closed when entering a `terminal: true` state) |
| `payload` | object | Mutable task data; input to guards and dispatch mappings |
| `assignee` | string \| null | Informational in v1 (user/actor public ID) |
| `active_dispatch` | object \| null | `{kind: "generation" \| "orchestration_run", id, status}` |
| `automation_status` | string \| null | `running` \| `completed` \| `failed` for the current state's dispatch |
| `entered_state_at` | string | Basis for `stalled_after` |
| `created_at` / `updated_at` | string | Timestamps |

### TaskTransition (append-only)

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `task_tr_` prefix |
| `task_id` | string | Owning task |
| `from_state` / `to_state` | string | The move (`from_state` null on creation) |
| `transition` | string \| null | Transition name fired (null for initial placement) |
| `actor_kind` | string | `user` \| `api_key` \| `automation` \| `approval` |
| `actor_id` | string \| null | Principal or automation provenance |
| `generation_id` / `run_id` | string \| null | Dispatch that caused the move |
| `note` | string \| null | Optional reason |
| `created_at` | string | Timestamp |

**Indexing:** `(project_id, workflow_id, state, status)` on Task for board
queries; `(task_id, created_at)` on TaskTransition;
`(project_id, status, entered_state_at)` for the stall sweeper.

---

## 5. Workflow definition schema

```json
{
  "name": "content-pipeline",
  "payload_schema": { "properties": { "topic": { "type": "string" } } },
  "states": [
    { "name": "triage", "initial": true,
      "on_enter": {
        "dispatch": { "kind": "agent", "agent_id": "agent_x1",
          "input_mapping": { "prompt": { "cat": ["Classify: ", { "var": "task.payload.topic" }] } } },
        "on_complete": [
          { "when": { "==": [{ "var": "result.category" }, "simple"] }, "transition": "to_draft" },
          { "when": true, "transition": "to_review" }
        ],
        "on_failure": null
      } },
    { "name": "draft",
      "on_enter": { "dispatch": { "kind": "orchestration", "orchestration_id": "orch_y2",
        "input_mapping": { "topic": { "var": "task.payload.topic" } } },
        "on_complete": [ { "when": true, "transition": "to_review" } ] } },
    { "name": "review", "kind": "human", "stalled_after": 172800 },
    { "name": "published", "terminal": true }
  ],
  "transitions": [
    { "name": "to_draft",   "from": ["triage", "review"], "to": "draft" },
    { "name": "to_review",  "from": ["triage", "draft"],  "to": "review" },
    { "name": "publish",    "from": ["review"], "to": "published",
      "requires_approval": true,
      "guard": { "==": [{ "var": "task.payload.approved_by_legal" }, true] } }
  ]
}
```

Semantics:

- **States** — exactly one `initial`; any number `terminal`. `kind: human`
  states never dispatch. Backward moves (`review → draft`) are just
  transitions — cycles are the point, not an error.
- **Transitions** — named, with `from` (list of states) and `to` (one state).
  A transition not defined here cannot be fired by anyone; there is no
  "free move" escape hatch (define an explicit any-state transition if a
  workflow wants one).
- **Guards** — JSON Logic over `{task, transition, actor}`; a false guard
  rejects the transition with `TASK_GUARD_REJECTED` (400-class), before any
  state change. Same expression engine as orchestration mappings.
- **`on_enter.dispatch`** — one agent generation or orchestration run;
  `input_mapping` resolves against `{task}`. The result is exposed to
  `on_complete` rules as `{result}` (generation output or run artifacts) and
  written to `task.payload.last_result` for downstream states.
- **Payload updates** — `PATCH /tasks/{id}` may update `payload` (validated
  against `payload_schema` when present); `state` is never directly writable —
  only `transitionTask` moves it.

Definition updates: structural changes re-validate; existing tasks in a state
that a new definition removes stay put but can only leave via transitions
valid in the new definition (same posture as orchestration update validation —
the definition is the sole authority at fire time).

---

## 6. Transition semantics (the hard part)

1. **Single path.** Every state change — human, API, automation outcome,
   approval resolution — goes through `transitionTask`. No writer updates
   `Task.state` directly.
2. **Atomicity.** Guard evaluation and state change happen under a row lock.
   Losers of a race re-validate: if the transition is still valid from the new
   state it proceeds; otherwise `TASK_TRANSITION_CONFLICT` (409).
3. **Automation outcome routing.** When a dispatch completes, `on_complete`
   rules are evaluated in order against `{task, result}`; the first match
   fires its transition *as the `automation` actor*, subject to the same guard
   checks. No match → the task stays, `automation_status: completed`, and a
   `tasks.automation_unrouted` event fires (never silently stuck).
4. **Cancellation on exit.** Leaving a state with a running dispatch cancels
   that dispatch (orchestration runs via the existing cancel path; generations
   are detached — their late result is discarded, recorded on the trace).
5. **Approval gating.** A `requires_approval` transition parks as a pending
   `ApprovalItem` (task shows `pending_transition`); approval fires the
   transition as the `approval` actor, rejection clears it with a history
   note. Expiry follows the approvals module's server-side enforcement.
6. **Stall timers.** The sweeper compares `entered_state_at` against the
   state's `stalled_after` and emits `tasks.stalled` once per stall episode
   (re-armed on the next transition).

---

## 7. Authorization model (v1)

| Permission | Surface |
|---|---|
| `workflows:CreateWorkflow` / `UpdateWorkflow` / `DeleteWorkflow` / `GetWorkflow` / `ListWorkflows` | Workflow CRUD |
| `tasks:CreateTask` | `POST /api/v1/tasks` |
| `tasks:GetTask` / `tasks:ListTasks` | Reads, board queries, history |
| `tasks:TransitionTask` | `POST /api/v1/tasks/{task_id}/transitions` |
| `tasks:UpdateTask` | Payload/title/assignee patches |
| `tasks:DeleteTask` | Hard delete (history cascades) |

Project-scoped like every other module; no per-task ACLs in v1. Agents
transition tasks through the MCP surface with the same permissions as any
principal — guards apply uniformly.

---

## 8. REST API

| Method | Path | Function |
|---|---|---|
| POST | `/api/v1/workflows` | Create definition (validated) |
| GET | `/api/v1/workflows` / `/{workflow_id}` | List / get |
| PATCH | `/api/v1/workflows/{workflow_id}` | Update (structural changes re-validate) |
| DELETE | `/api/v1/workflows/{workflow_id}` | Delete (rejected while open tasks exist) |
| POST | `/api/v1/tasks` | Create task (`workflow_id`, `title`, `payload`) — placed in the initial state, fires its `on_enter` |
| GET | `/api/v1/tasks` | List; filters: `workflow_id`, `state`, `status`, `assignee` (the board query) |
| GET | `/api/v1/tasks/{task_id}` | Full task with `active_dispatch` |
| PATCH | `/api/v1/tasks/{task_id}` | Update payload/title/assignee (never `state`) |
| POST | `/api/v1/tasks/{task_id}/transitions` | Fire a named transition (`{transition, note?}`) |
| GET | `/api/v1/tasks/{task_id}/history` | Transition history |
| DELETE | `/api/v1/tasks/{task_id}` | Delete |

Bodies snake_case per the case convention; MCP tools (`create-workflow`,
`transition-task`, `list-tasks`, …) auto-generate from the OpenAPI specs via
`soatTools.ts`; SDK and CLI regenerate from the same specs.

**Webhook events:** `tasks.created`, `tasks.transitioned`, `tasks.stalled`,
`tasks.automation_unrouted`, `tasks.closed`.

---

## 9. Interaction with existing modules

| Module | Relationship |
|---|---|
| **Orchestrations** | Dispatch target for a state's work; a task never replaces a run. Docs must carry the boundary rule (§0) and a "which do I use?" table. |
| **Agents** | Dispatch target (`on_enter` generation); also a *consumer* — an agent with `tasks:TransitionTask` can move cards via MCP. |
| **Approvals** | `requires_approval` transitions are a new approval *producer* over the existing emit/resolve core — no new queue machinery. |
| **Triggers / Webhooks** | Time- or event-driven transitions compose externally: a trigger fires, its handler calls `transition-task`. Keeps v1 timer surface minimal. |
| **Traces / usage** | Dispatched generations/runs trace and meter exactly as they do today; the task adds provenance links only. |

---

## 10. Success criteria

- The kanban scenario builds with **zero** application-side state: workflow =
  board definition, tasks = cards, `GET /tasks?workflow_id=...&state=...` =
  columns, history = card activity.
- A backward move (`review → draft → review`) works and is fully audited —
  the case orchestrations reject by design.
- Removing the module's automation (Phase 2) still leaves a useful product
  (Phase 1 standalone) — evidence the layering is right.
- No duplicated machinery: approvals reuse the approvals core, timers reuse
  the scheduler, expressions reuse JSON Logic, dispatch reuses
  generations/runs as-is.

## 11. Open questions

1. **Naming.** `workflows` risks confusion with orchestrations in docs and
   marketing ("workflow engine"). Alternatives: `taskflows`, `boards`
   (too UI-flavored), `state-machines` (precise but dry). Recommend
   `workflows`/`tasks` with the boundary rule stated prominently, but this
   deserves a deliberate call before the OpenAPI surface ships.
2. **`on_complete` result shape for orchestration dispatch.** Expose the full
   run `artifacts`, only `state`, or a declared output mapping on the
   orchestration? (Recommend: run `state` namespaced under `result`, matching
   sub-orchestration semantics.)
3. **Payload size and mutability.** Should `payload` writes be versioned in
   history like transitions are? (Recommend: no in v1; `payload` is data,
   transitions are the audited contract — revisit if audit demand appears.)
4. **Multi-dispatch states.** v1 allows one dispatch per state. Fan-out
   ("three agents review in parallel") is expressible today by dispatching an
   orchestration that fans out internally — keep it that way, or allow
   dispatch lists later?
5. **Task→task relations** (parent/child, blocking). Real boards want them
   eventually; deliberately out of v1 to keep the model small.
