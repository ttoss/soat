# PRD: Usage Metering

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G5).
> Depends on the idempotency keys from
> [prd-orchestration-queue.md](./prd-orchestration-queue.md) for
> exactly-once accounting under retries; feeds the `usage.*` guard context in
> [prd-guardrails.md](./prd-guardrails.md).

## Implementation Status

| Component                                  | Status         | Notes                                                                |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------------|
| `UsageMeter` model (append-only)           | ❌ Not started | One row per LLM call; unique idempotency key                          |
| Provider-call wrapper instrumentation      | ❌ Not started | Single write site covering all providers/paths                        |
| Price book + write-time cost computation   | ❌ Not started | Cost frozen at write time with the then-current price                 |
| Aggregation endpoint                       | ❌ Not started | Per project/period, grouped by model/agent/orchestration              |
| `usage.threshold_crossed` webhook event    | ❌ Not started | For downstream billing/alerting pipelines                             |
| `usage.*` guard context provider           | ❌ Not started | Budget ceilings enforceable by the guardrail evaluator                |

## Implementation Phases

### Phase 1 — Meter Rows + Idempotency ❌ Not started

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

### Phase 2 — Price Book + Cost ❌ Not started

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

**Goal:** Usage is queryable and pushable, not just stored.

**Deliverables:**

- `GET /api/v1/usage?project_id&from&to&group_by=model|agent|orchestration|day`
  returning token and cost rollups
- Webhook event `usage.threshold_crossed` — fired when a project's
  cost/tokens in a configured window crosses a configured threshold (config
  on the project; hysteresis so it fires once per crossing)

**Unlocks:** Unit-economics reporting per project/cycle/role and proactive
budget alerts without polling.

### Phase 4 — Budget Guard Integration ❌ Not started

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

| Column          | Type      | Constraints                          |
| --------------- | --------- | ------------------------------------ |
| provider        | VARCHAR   | NOT NULL                             |
| model           | VARCHAR   | NOT NULL                             |
| inputPricePerM  | DECIMAL   | USD per million input tokens         |
| outputPricePerM | DECIMAL   | USD per million output tokens        |
| cachedPricePerM | DECIMAL   | NULL → falls back to input price     |
| effectiveFrom   | TIMESTAMP | NOT NULL; latest row ≤ now() applies |

## Permissions

| Permission              | Endpoint                          |
| ----------------------- | ---------------------------------- |
| `usage:GetUsage`        | `GET /api/v1/usage`                |
| `usage:ListUsageMeters` | `GET /api/v1/usage/meters`         |
| `usage:ManagePriceBook` | `PUT /api/v1/usage/prices` (admin) |

## REST API

| Method | Path                     | Description                                             |
| ------ | ------------------------ | ------------------------------------------------------- |
| GET    | `/api/v1/usage`          | Aggregated usage (`project_id`, `from`, `to`, `group_by`) |
| GET    | `/api/v1/usage/meters`   | Raw meter rows, cursor-paginated (audit/reconciliation)   |
| GET    | `/api/v1/usage/prices`   | Current price book                                        |
| PUT    | `/api/v1/usage/prices`   | Upsert price rows (admin)                                 |
