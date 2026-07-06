# PRD: Schedules Module

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G1).
> Depends on [prd-orchestration-queue.md](./prd-orchestration-queue.md) for
> enqueueing fired runs; works degraded (direct `startOrchestrationRun`) until
> the queue ships.

## Implementation Status

| Component                                  | Status         | Notes                                                                 |
| ------------------------------------------ | -------------- | --------------------------------------------------------------------- |
| `Schedule` model + lib                     | ❌ Not started | `sch_` prefix, cron + timezone + input                                |
| Cron firing in the scheduler tick          | ❌ Not started | Reuses the existing orchestration scheduler loop (`orchestrationScheduler.ts`) |
| Overlap policies (`skip`/`queue`/`cancel_previous`) | ❌ Not started |                                                                |
| Missed-fire grace window                   | ❌ Not started |                                                                       |
| Pause / resume                             | ❌ Not started | Kill switch without deleting the resource                             |
| REST endpoints + OpenAPI + permissions     | ❌ Not started | MCP tools derive automatically from the OpenAPI spec                  |
| `schedule` formation resource type         | ❌ Not started | `schedulesFormationModule.ts` + `ScheduleResourceProperties`          |
| Webhook events (`schedules.*`)             | ❌ Not started |                                                                       |

## Implementation Phases

### Phase 1 — Core Cron Firing ❌ Not started

**Goal:** A schedule starts an orchestration run on a cron cadence with fixed
input, with no caller involved.

**Deliverables:**

- `Schedule` model (see [Data Model](#data-model)) and `src/lib/schedules.ts`
- Firing integrated into the existing scheduler tick (the same loop that wakes
  `sleeping` runs and reaps expired leases — `orchestrationScheduler.ts`):
  scan `enabled = true AND next_fire_at <= now()`, start the run, advance
  `next_fire_at` from the cron expression and timezone
- Single-leader firing via a Postgres advisory lock so multi-process
  deployments fire each schedule exactly once per due time — no new
  infrastructure
- One-minute resolution (the tick already runs every 5s; cron granularity is
  minutes)
- Cron parsing/next-occurrence via a standard 5-field cron library; timezone
  defaults to `UTC`
- REST CRUD + OpenAPI spec + permissions + SDK/CLI regeneration + module docs

**Unlocks:** Recurring agent cycles (daily analysis, periodic syncs) with zero
external schedulers.

### Phase 2 — Overlap and Missed-Fire Policies ❌ Not started

**Goal:** Deterministic behavior when a cycle is still running at its next due
time, or when the server was down over a due time.

**Deliverables:**

- `overlap_policy`:
  - `skip` (default) — if a run started by this schedule is still active
    (`queued`/`running`/`sleeping`/`awaiting_input`), log and skip this fire
  - `queue` — start the run anyway; it waits behind the project concurrency
    limit ([prd-orchestration-queue.md](./prd-orchestration-queue.md))
  - `cancel_previous` — cancel the still-active previous run, then fire
- `grace_seconds`: after downtime, a missed fire within the grace window fires
  **once**; older missed fires are skipped and recorded (no unbounded
  catch-up storms)
- `last_fired_at` / `last_run_id` bookkeeping so overlap checks are exact, not
  heuristic

**Unlocks:** Schedules that are safe by default — a daily optimization pass
can never run twice concurrently on one project.

### Phase 3 — Lifecycle, Formation Resource, Events ❌ Not started

**Goal:** Schedules are pausable product state, declarable in templates, and
observable without polling.

**Deliverables:**

- `POST /schedules/:id/pause` and `/resume` (kill switch per project — e.g.
  during onboarding — without deleting the formation)
- Formation resource type `schedule` (`schedulesFormationModule.ts`,
  `ScheduleResourceProperties` in `formations.yaml`); cron as a template
  parameter so per-project cadence is a deploy-time value:

```yaml
resources:
  DailyCycle:
    type: schedule
    properties:
      orchestration_id: { ref: DailyFlow }
      cron: { param: DailyCycleCron } # default: "0 8 * * *"
      timezone: America/Sao_Paulo
      overlap_policy: skip
      input: { cycle: daily }
```

- Webhook events: `schedules.fired` (with the started `run_id`),
  `schedules.skipped` (overlap or missed-fire skip, with the reason)

**Unlocks:** One template declares both the flow and its cadence; operators
pause a project's cycles with one call.

## Overview

A **schedule** is a project-scoped resource that starts an
[orchestration](../packages/website/docs/modules/orchestrations.md) run on a
cron cadence with a fixed input payload. It is the trigger layer that turns a
deployed formation from a passive topology into an operating system of record:
runs happen because time passed, not because a caller showed up.

Schedules deliberately reuse the existing orchestration scheduler loop — the
process-internal tick that already wakes sleeping runs — rather than adding a
new daemon or external cron dependency.

## Key Concepts

### Firing

A schedule stores a precomputed `next_fire_at`. Each scheduler tick claims due
schedules (advisory lock → exactly-once per due time across processes), starts
the orchestration run with the schedule's `input`, stamps
`last_fired_at`/`last_run_id`, and advances `next_fire_at`.

The started run is a normal `OrchestrationRun` — observable via
`get-orchestration-run`, run lifecycle webhook events, and traces. The run
records `schedule_id` as its origin.

### Overlap Policy

Evaluated at fire time against the schedule's previous run. `skip` is the
default because recurring optimization/analysis cycles are almost never safe
to double-run against the same project state.

### Missed Fires

The due check is `next_fire_at <= now()`, so a fire missed during downtime is
naturally picked up on the next tick. `grace_seconds` bounds how stale a due
time may be and still fire (default: one cadence interval, capped); anything
older is skipped with a `schedules.skipped` event. Catch-up never fires more
than once per schedule.

## Data Model

### Schedule

| Field              | Type           | Description                                                        |
| ------------------ | -------------- | ------------------------------------------------------------------ |
| `id`               | string         | Public ID (`sch_` prefix)                                          |
| `project_id`       | string         | Owning project                                                     |
| `orchestration_id` | string         | Orchestration to run on each fire                                  |
| `name`             | string         | Human-readable name                                                |
| `cron`             | string         | 5-field cron expression                                            |
| `timezone`         | string         | IANA timezone name (default `UTC`)                                 |
| `input`            | object \| null | Fixed input passed to `start-orchestration-run`                    |
| `overlap_policy`   | string         | `skip` (default) \| `queue` \| `cancel_previous`                   |
| `grace_seconds`    | integer \| null | Missed-fire grace window; `null` = one cadence interval           |
| `enabled`          | boolean        | Paused schedules retain state but never fire                       |
| `last_fired_at`    | string \| null | ISO 8601 timestamp of the last fire                                |
| `last_run_id`      | string \| null | Run started by the last fire (drives overlap checks)               |
| `next_fire_at`     | string \| null | Precomputed next due time (indexed; `null` while disabled)         |
| `created_at`       | string         |                                                                    |
| `updated_at`       | string         |                                                                    |

Indexes: `(next_fire_at) WHERE enabled`, `(project_id)`, unique `(publicId)`.

## Permissions

| Permission                  | Endpoint                                |
| --------------------------- | ---------------------------------------- |
| `schedules:CreateSchedule`  | `POST /api/v1/schedules`                 |
| `schedules:ListSchedules`   | `GET /api/v1/schedules`                  |
| `schedules:GetSchedule`     | `GET /api/v1/schedules/:scheduleId`      |
| `schedules:UpdateSchedule`  | `PUT /api/v1/schedules/:scheduleId`      |
| `schedules:DeleteSchedule`  | `DELETE /api/v1/schedules/:scheduleId`   |
| `schedules:PauseSchedule`   | `POST /api/v1/schedules/:scheduleId/pause` |
| `schedules:ResumeSchedule`  | `POST /api/v1/schedules/:scheduleId/resume` |

## REST API

All body fields snake_case per project convention. MCP tools
(`create-schedule`, `pause-schedule`, …) derive automatically from the OpenAPI
spec via `soatTools.ts`.

| Method | Path                                   | Description                          |
| ------ | -------------------------------------- | ------------------------------------ |
| POST   | `/api/v1/schedules`                    | Create a schedule                    |
| GET    | `/api/v1/schedules`                    | List schedules (filter by project)   |
| GET    | `/api/v1/schedules/:scheduleId`        | Get a schedule                       |
| PUT    | `/api/v1/schedules/:scheduleId`        | Update cron/timezone/input/policies  |
| DELETE | `/api/v1/schedules/:scheduleId`        | Delete a schedule                    |
| POST   | `/api/v1/schedules/:scheduleId/pause`  | Disable firing, keep state           |
| POST   | `/api/v1/schedules/:scheduleId/resume` | Re-enable and recompute `next_fire_at` |
