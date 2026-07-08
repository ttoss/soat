# PRD: Usage Metering

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G5).
> Depends on the idempotency keys from
> [prd-orchestration-queue.md](./prd-orchestration-queue.md) for
> exactly-once accounting under retries; feeds the `usage.*` guard context in
> [prd-guardrails.md](./prd-guardrails.md).

## Implementation Status

| Component                                  | Status                     | Notes                                                                |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------|
| `UsageMeter` model (append-only)           | ✅ Done (#483)              | One row per completed generation; unique idempotency key on the generation |
| Provider-call instrumentation              | 🚧 Agent path (#483)        | Wired for agent generations, conversations, and orchestration agent nodes; extraction/discussions/chats still pending |
| Reasoning-token breakdown                  | ✅ Done (#483)              | `reasoning_tokens` (and cached) captured from the provider report     |
| `trace_id` attribution                     | ✅ Done (#484)              | Meter links to its trace; filterable                                  |
| Trigger + logical action-id attribution    | 🚧 Agent-target (#485)      | `trigger_id`/`action_id` on the meter; in-orchestration-run trigger attribution pending run-scoping |
| Price book + write-time cost computation   | ✅ Done (#488)              | Cost frozen at write time from the effective price row                |
| Default price seeding                      | ✅ Done (#488)              | Common provider/model defaults seeded idempotently at startup         |
| Aggregation endpoint                       | ❌ Not started              | Grouped rollups (a raw meter list with filters exists today)          |
| `usage.threshold_crossed` webhook event    | ❌ Not started              | For downstream billing/alerting pipelines                             |
| Threshold config (`UsageThreshold` table)  | ❌ Not started              | Per-project thresholds + fire state driving `usage.threshold_crossed` |
| `usage.*` guard context / per-run ceiling  | ⏭️ Deferred                 | Needs the guardrail evaluator ([prd-guardrails.md](./prd-guardrails.md)), which is unbuilt |

## Implementation Phases

### Phase 1 — Meter Rows + Idempotency ✅ Done (#483)

> Delivered for the agent-completion path (agent generations, conversations,
> orchestration agent nodes). Idempotency is keyed on the generation; the
> node-level idempotency key from the orchestration queue is pending
> run-scoping. Reasoning/cached token breakdown (#483), `trace_id` (#484), and
> trigger/action attribution (#485) were added on top via epic #482.

**Goal:** Every LLM call produces exactly one attribution-complete usage row —
including under at-least-once redelivery.

**Deliverables:**

- `UsageMeter` model (see [Data Model](#data-model)); **append-only** — no
  update or delete path
- Instrumentation in the shared provider-call wrapper (the single choke point
  all completions already flow through — agent generations, extraction,
  discussions), recording provider, model, input/output/cached tokens, and
  the attribution chain `project → run → node → agent → generation`
- `idempotency_key` unique constraint: the key derives from the generation
  and, inside orchestration runs, from the node idempotency key
  ([prd-orchestration-queue.md](./prd-orchestration-queue.md)) — a replayed
  node upserts into a no-op instead of double counting
- Tenancy tests over the new table

**Unlocks:** Trustworthy raw usage data; the acceptance test "replayed nodes
produce exactly one row per LLM call".

### Phase 2 — Price Book + Cost ✅ Done (#488)

> Meters with no matching price row record `cost_usd = null` and are visible
> through the standard meter list (no separate "missing price" admin view).
> SOAT ships default prices, seeded at startup, that operators override with
> future-dated rows.

**Goal:** Cost in USD computed at write time, immune to later price changes.

**Deliverables:**

- `PriceBook` table: `(provider, model, input/output/cached unit prices,
  effective_from)`; admin CRUD
- `cost_usd` computed at meter-write time from the price row effective at
  that moment — recorded costs never change retroactively when prices update
- Meters with no matching price row record tokens with `cost_usd = null`
  (visible, not lost) and surface in a "missing price" admin view

**Unlocks:** Billing-grade cost data downstream consumers can invoice from.
Defining the customer-facing billing unit stays out of scope — SOAT meters,
the consuming product bills.

### Phase 3 — Aggregation + Events ❌ Not started

> A raw meter list (`GET /api/v1/usage/meters`) with agent/generation/trace/
> trigger/action filters exists; the grouped aggregation endpoint, thresholds,
> and the `usage.threshold_crossed` webhook are not yet built.

**Goal:** Usage is queryable and pushable, not just stored.

**Deliverables:**

- `GET /api/v1/usage?project_id&from&to&group_by=model|agent|orchestration|day`
  returning token and cost rollups
- `UsageThreshold` table + CRUD endpoints (see
  [Usage Thresholds](#usage-thresholds)) — per-project thresholds on cost or
  tokens over a calendar-month or rolling-24h window
- Webhook event `usage.threshold_crossed` — fired when a project's
  cost/tokens in the configured window crosses a configured threshold, with
  the once-per-window / hysteresis re-fire rules defined in
  [Usage Thresholds](#usage-thresholds)

**Unlocks:** Unit-economics reporting per project/cycle/role and proactive
budget alerts without polling.

### Phase 4 — Budget Guard Integration ⏭️ Deferred

> Blocked on the guardrail evaluator and `usage.*` guard context
> ([prd-guardrails.md](./prd-guardrails.md)), which are unbuilt. The per-run
> token-ceiling issue (#486) was deferred for the same reason.

**Goal:** Runaway cycles trip fail-closed like any other guard.

**Deliverables:**

- `usage.*` context provider for the
  [guardrail evaluator](./prd-guardrails.md):
  `usage.cost_usd(window)`, `usage.tokens(window)`, per project
- Documented pattern: a class-B rule guarded by
  `{'<': [{var: 'usage.cost_usd_24h'}, {var: 'project.context.cost_ceiling'}]}`
  aborts (tripwire → exception) when the ceiling is hit

**Unlocks:** Hard per-project spend ceilings enforced deterministically at the
tool boundary.

## Overview

SOAT currently records generations and traces but neither token usage nor
cost. Anyone operating agents per customer project needs to answer "what did
this project/run/agent cost this period" from the platform, and needs the
numbers to be **billing-grade**: append-only, idempotent under retries, priced
at write time.

The write side is deliberately one place — the shared provider-call wrapper —
so every provider and every path (agents, extraction, discussions,
orchestration nodes) meters identically, and adding a provider cannot silently
skip metering.

## Usage Thresholds

**Decision:** thresholds live in a dedicated `UsageThreshold` table, not a
JSONB field on `Project` — each threshold carries mutable fire state
(`last_fired_at`, `fired_window_key`) that the hysteresis rules depend on,
and mixing per-row state machines into an unvalidated JSONB blob would make
the once-per-window guarantee unenforceable at the DB level.

A project can have multiple thresholds (e.g. a 50 USD warning and a 100 USD
alert). Each threshold is defined by:

- `metric` — `cost_usd` | `tokens` (tokens = input + output + cached)
- `window` — explicit, one of:
  - `calendar_month` — the current UTC calendar month; resets at
    00:00 UTC on the 1st. The window key is `YYYY-MM` (e.g. `2026-07`).
  - `rolling_24h` — the trailing 24 hours, evaluated at each meter write.
- `threshold` — the numeric value the windowed aggregate must cross.

Evaluation happens synchronously after each `UsageMeter` write (the write is
already the single choke point), comparing the windowed aggregate against
every threshold on the meter's project.

**Re-fire rules (hysteresis):**

- `calendar_month` — fires **at most once per threshold per window**: on
  firing, `fired_window_key` is set to the current window key; the threshold
  cannot fire again until the key changes (i.e. resets at the window
  boundary). Usage in a calendar window only grows (meters are append-only),
  so no hysteresis band is needed.
- `rolling_24h` — the windowed value can fall as old meters age out, so a
  fired threshold **re-arms only when the value drops below 90% of the
  threshold** (10% hysteresis band); it may then fire again on the next
  crossing. This prevents flapping when usage hovers at the threshold.
- Deleting and recreating a threshold resets its fire state.

Webhook payload (snake_case, standard webhook envelope):

```json
{
  "type": "usage.threshold_crossed",
  "data": {
    "threshold_id": "uthr_V1StGXR8Z5jdHi6B",
    "project_id": "proj_V1StGXR8Z5jdHi6B",
    "metric": "cost_usd",
    "window": "calendar_month",
    "window_key": "2026-07",
    "threshold": 100,
    "observed_value": 101.37
  }
}
```

(`window_key` is `null` for `rolling_24h`.)

Configuration endpoints (see [REST API](#rest-api)):
`GET /api/v1/usage/thresholds?project_id=…`,
`POST /api/v1/usage/thresholds`,
`DELETE /api/v1/usage/thresholds/{threshold_id}`. Thresholds are immutable
apart from deletion — replace by delete + create, which keeps the fire-state
semantics trivial.

## Data Model

### UsageMeter

| Column          | Type         | Constraints                                        |
| --------------- | ------------ | --------------------------------------------------- |
| id              | INTEGER      | PK                                                  |
| publicId        | VARCHAR(32)  | UNIQUE, `um_` prefix                                |
| projectId       | INTEGER      | FK → Project, NOT NULL                              |
| runId           | INTEGER      | FK → OrchestrationRun, NULL                         |
| nodeId          | VARCHAR      | NULL (node within the run)                          |
| agentId         | INTEGER      | FK → Agent, NULL                                    |
| generationId    | INTEGER      | FK → Generation, NULL                               |
| provider        | VARCHAR      | NOT NULL                                            |
| model           | VARCHAR      | NOT NULL                                            |
| inputTokens     | INTEGER      | NOT NULL                                            |
| outputTokens    | INTEGER      | NOT NULL                                            |
| cachedTokens    | INTEGER      | NOT NULL DEFAULT 0                                  |
| costUsd         | DECIMAL      | NULL when no price row matched                      |
| idempotencyKey  | VARCHAR      | UNIQUE, NOT NULL                                    |
| createdAt       | TIMESTAMP    | NOT NULL; no updatedAt — rows are immutable         |

Indexes: `(projectId, createdAt)`, `(runId)`, unique `(idempotencyKey)`.

### PriceBook

| Column          | Type         | Constraints                          |
| --------------- | ------------ | ------------------------------------ |
| id              | INTEGER      | PK                                   |
| publicId        | VARCHAR(32)  | UNIQUE, `price_` prefix (registered in `packages/postgresdb/src/utils/publicId.ts`) |
| provider        | VARCHAR      | NOT NULL                             |
| model           | VARCHAR      | NOT NULL                             |
| inputPricePerM  | DECIMAL      | USD per million input tokens         |
| outputPricePerM | DECIMAL      | USD per million output tokens        |
| cachedPricePerM | DECIMAL      | NULL → falls back to input price     |
| effectiveFrom   | TIMESTAMP    | NOT NULL; latest row ≤ now() applies |
| createdAt       | TIMESTAMP    | NOT NULL                             |

Unique index: `(provider, model, effectiveFrom)` — the upsert key (see
[Price book upsert](#price-book-upsert)).

### UsageThreshold

| Column         | Type         | Constraints                                            |
| -------------- | ------------ | ------------------------------------------------------- |
| id             | INTEGER      | PK                                                      |
| publicId       | VARCHAR(32)  | UNIQUE, `uthr_` prefix (registered in `packages/postgresdb/src/utils/publicId.ts`) |
| projectId      | INTEGER      | FK → Project, NOT NULL                                  |
| metric         | VARCHAR      | NOT NULL; `cost_usd` \| `tokens`                        |
| window         | VARCHAR      | NOT NULL; `calendar_month` \| `rolling_24h`             |
| threshold      | DECIMAL      | NOT NULL, > 0                                           |
| lastFiredAt    | TIMESTAMP    | NULL until first fire                                   |
| firedWindowKey | VARCHAR      | NULL; `YYYY-MM` key for `calendar_month` hysteresis     |
| createdAt      | TIMESTAMP    | NOT NULL                                                |

Index: `(projectId)`. Fire-state semantics are defined in
[Usage Thresholds](#usage-thresholds).

## Permissions

| Permission                | Endpoint                                            |
| ------------------------- | ---------------------------------------------------- |
| `usage:GetUsage`          | `GET /api/v1/usage`                                  |
| `usage:ListUsageMeters`   | `GET /api/v1/usage/meters`                           |
| `usage:ManagePriceBook`   | `PUT /api/v1/usage/prices` (admin)                   |
| `usage:ListThresholds`    | `GET /api/v1/usage/thresholds`                       |
| `usage:ManageThresholds`  | `POST /api/v1/usage/thresholds`, `DELETE /api/v1/usage/thresholds/{threshold_id}` |

Actions are defined in `packages/server/src/permissions/usage.json`.

## REST API

| Method | Path                                       | Description                                             |
| ------ | ------------------------------------------ | ------------------------------------------------------- |
| GET    | `/api/v1/usage`                            | Aggregated usage (`project_id`, `from`, `to`, `group_by`) |
| GET    | `/api/v1/usage/meters`                     | Raw meter rows, cursor-paginated (audit/reconciliation)   |
| GET    | `/api/v1/usage/prices`                     | Current price book                                        |
| PUT    | `/api/v1/usage/prices`                     | Upsert price rows (admin)                                 |
| GET    | `/api/v1/usage/thresholds`                 | List thresholds (`project_id` filter)                     |
| POST   | `/api/v1/usage/thresholds`                 | Create a threshold                                        |
| DELETE | `/api/v1/usage/thresholds/{threshold_id}`  | Delete a threshold (resets its fire state)                |

### Price book upsert

`PUT /api/v1/usage/prices` takes a batch of rows keyed on
`(provider, model, effective_from)`.

**Decision:** rows whose `effective_from` is already in the past are
immutable — upserting onto a past-effective key returns `400`. Recorded
`cost_usd` values are frozen at write time, so allowing historical price
edits would make the price book disagree with the costs it supposedly
explains; corrections ship as new future-dated rows.

Request:

```json
{
  "prices": [
    {
      "provider": "openai",
      "model": "gpt-4o",
      "input_price_per_m": 2.5,
      "output_price_per_m": 10.0,
      "cached_price_per_m": 1.25,
      "effective_from": "2026-08-01T00:00:00Z"
    }
  ]
}
```

Response (`200`; each row carries its public ID):

```json
{
  "prices": [
    {
      "id": "price_V1StGXR8Z5jdHi6B",
      "provider": "openai",
      "model": "gpt-4o",
      "input_price_per_m": 2.5,
      "output_price_per_m": 10.0,
      "cached_price_per_m": 1.25,
      "effective_from": "2026-08-01T00:00:00Z",
      "created_at": "2026-07-07T12:00:00Z"
    }
  ]
}
```

A row matching an existing future-dated `(provider, model, effective_from)`
key replaces that row's prices; otherwise a new row is inserted.
