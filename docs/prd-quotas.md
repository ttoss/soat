# PRD: Quotas & Rate Limiting

> Part of [Agent Operations on Formations](./prd-agent-operations.md).
> Depends on the meter-write choke point from
> [prd-usage-metering.md](./prd-usage-metering.md) (Phase 1) for token/cost
> windows; complements the per-action classification in
> [prd-guardrails.md](./prd-guardrails.md).

## Implementation Status

| Component                                   | Status         | Notes                                                        |
| ------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `Quota` model + CRUD                        | ❌ Not started | Project-scoped; scope/metric/window/limit/mode                |
| `QuotaWindowCounter` table                  | ❌ Not started | Per-window fixed counters for `requests`                      |
| Request-quota Koa middleware                | ❌ Not started | After auth, before handlers; atomic `UPDATE ... RETURNING`    |
| `QUOTA_EXCEEDED` error code + `429` contract | ❌ Not started | `Retry-After` header; registered in `errors/codes.ts`         |
| Token/cost check at meter-write choke point | ❌ Not started | Pre-generation check; never kills an in-flight generation     |
| `quota.exceeded` webhook event              | ❌ Not started | First breach per window (reuses metering hysteresis pattern)  |
| Monitor mode + audit entries                | ❌ Not started | Log/webhook without blocking, for safe rollout                |
| `quota` formation resource type             | ❌ Not started | `QuotaResourceProperties` in `formations.yaml`                |

## Problem

The platform can now *measure* spend
([usage metering](./prd-usage-metering.md) meters every LLM call and alerts
via `usage.threshold_crossed`) and *classify* individual actions
([guardrails](./prd-guardrails.md) route a single tool call to
execute/approve/block). Neither **enforces an aggregate hard cap**: a
threshold webhook that nobody consumes does not stop a runaway agent loop,
and a guardrail evaluates one action at a time, not "this API key made 4,000
requests this minute". There is no rate-limit middleware in
`packages/server/src/middleware/` today (`auth.ts`, `caseTransform.ts`,
`errorLogger.ts`, `strictFields.ts` — nothing throttles). For a platform
whose core product is autonomous tool loops, blocking enforcement is a
prerequisite for giving any agent long-lived credentials: requests/minute per
API key, monthly spend ceilings that block instead of notify, per-agent token
budgets.

### Boundary with adjacent PRDs

| Layer                                        | Question it answers                          | Blocking? |
| -------------------------------------------- | -------------------------------------------- | --------- |
| [Usage metering](./prd-usage-metering.md)    | "What did this cost?" (measure + alert)      | No        |
| [Guardrails](./prd-guardrails.md)            | "May this *one* tool call execute?"          | Per action |
| **Quotas (this PRD)**                        | "Has this scope exceeded its aggregate cap?" | Yes — 429 |

No overlap: quotas never inspect action arguments (guardrails' job) and never
compute cost (metering's job) — they compare a windowed aggregate to a limit.

The same holds for **request counting**: `QuotaWindowCounter` (this PRD,
atomic per-request increments to block) and the planned `api_request` meter
rows ([metering Phase 6](./prd-usage-metering.md#phase-6--api-request-metering--not-started),
flush-aggregated batches to bill) both count requests but are deliberately
separate — enforcement needs synchronous atomicity, billing needs cheap
batched writes, and neither can serve the other's write pattern.

## Goals

- Hard, fail-closed enforcement of request rates and token/cost budgets per
  project, API key, or agent.
- A stable `429` contract (`QUOTA_EXCEEDED` + `Retry-After`) that SDK/CLI/MCP
  clients can back off against.
- `monitor` mode so operators can observe would-be breaches before enforcing.

## Non-goals

- **Billing** — quotas cap, metering measures; invoicing stays downstream.
- **Per-user (JWT) quotas in v1** — API keys and agents are the autonomous
  surfaces that can run away; interactive users are not. Noted as future work.
- **Distributed in-memory token bucket** — v1 is Postgres-backed fixed
  windows (see Decisions).

## Key Concepts

A `Quota` is project-scoped and defined by:

- `scope` — `project` | `api_key` | `agent`, with optional `scope_ref`
  (the public id, e.g. `key_…` or `agent_…`). A scope without `scope_ref`
  applies to every entity of that scope type in the project.
- `metric` — `requests` | `tokens` | `cost_usd`.
- `window` — `rolling_1m` | `rolling_1h` | `rolling_24h` | `calendar_month`.
  For `requests`, rolling windows are implemented as fixed windows keyed by
  the truncated timestamp (`2026-07-07T12:31Z` for `rolling_1m`);
  `calendar_month` keys are `YYYY-MM`, matching metering's convention.
- `limit` — numeric, > 0.
- `mode` — `enforce` (block with `429`) | `monitor` (emit `quota.exceeded`
  webhook + audit entry, do **not** block). **Decision:** monitor mode ships
  in the same model from day one — a cap you cannot dry-run is a cap nobody
  turns on.

**Precedence — decision:** when multiple quotas match a request (e.g. a
project-wide cap and an API-key cap), **all `enforce` quotas are checked and
any breach blocks** (fail closed); the *most specific* scope
(`agent` > `api_key` > `project`) is the one reported in the error body and
webhook for attribution. A more specific quota never loosens a broader one.

### Enforcement points (by metric)

1. **`requests`** — a Koa middleware mounted after `auth` and before route
   handlers, so the counted identity (API key / resolved agent) is known and
   no handler work is wasted on a blocked request. Counters are
   Postgres-backed: one row per `(quota_id, window_key)` incremented with a
   single atomic `UPDATE … SET count = count + 1 … RETURNING count` (upsert
   on first hit); breach when the returned count exceeds `limit`.
   **Decision:** DB-backed counters rather than in-memory token buckets —
   correct across server replicas with zero coordination code; the
   single-digit-ms overhead of one indexed UPDATE is acceptable at v1
   traffic. An in-memory bucket in front of the DB is a noted future
   optimization, not a v1 requirement.
2. **`tokens` / `cost_usd`** — checked at the usage-metering write choke
   point (the single provider-call wrapper of
   [prd-usage-metering.md](./prd-usage-metering.md)): **before** starting a
   generation, the current window aggregate over `UsageMeter` is compared to
   the limit; a breach blocks the *new* generation with `QUOTA_EXCEEDED`.
   **Decision:** never kill a generation in flight — its tokens are already
   consumed and will be billed; aborting it wastes paid work without saving
   money. Budgets may therefore overshoot by at most one generation.

### Breach contract

HTTP `429` with a `Retry-After` header (seconds until `resets_at`; for
rolling token/cost windows, until the oldest contributing meter ages out) and
the standard `DomainError` body, following
`packages/server/src/errors/codes.ts` conventions (new registry entry
`QUOTA_EXCEEDED`, `httpStatus: 429`):

```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Quota exceeded for api_key key_V1StGXR8Z5jdHi6B.",
    "meta": {
      "quota_id": "quota_V1StGXR8Z5jdHi6B",
      "metric": "requests",
      "limit": 600,
      "window": "rolling_1m",
      "resets_at": "2026-07-07T12:32:00Z"
    }
  }
}
```

Webhook event `quota.exceeded` (standard envelope, snake_case) fires on the
**first breach per quota per window** — reusing the fire-state pattern from
metering's [Usage Thresholds](./prd-usage-metering.md#usage-thresholds):
`fired_window_key` for fixed/calendar windows; the 10% hysteresis re-arm band
for rolling token/cost windows. Monitor mode emits the same webhook plus an
audit entry and lets the request through.

## Data Model

### Quota

| Column    | Type        | Constraints                                                                    |
| --------- | ----------- | ------------------------------------------------------------------------------ |
| id        | INTEGER     | PK                                                                             |
| publicId  | VARCHAR(32) | UNIQUE, `quota_` prefix (registered in `packages/postgresdb/src/utils/publicId.ts`; no collision with existing prefixes) |
| projectId | INTEGER     | FK → Project, NOT NULL                                                         |
| scope     | VARCHAR     | NOT NULL; `project` \| `api_key` \| `agent`                                    |
| scopeRef  | VARCHAR     | NULL; public id of the key/agent; NULL = all entities of that scope            |
| metric    | VARCHAR     | NOT NULL; `requests` \| `tokens` \| `cost_usd`                                 |
| window    | VARCHAR     | NOT NULL; `rolling_1m` \| `rolling_1h` \| `rolling_24h` \| `calendar_month`    |
| limit     | DECIMAL     | NOT NULL, > 0                                                                  |
| mode      | VARCHAR     | NOT NULL DEFAULT `enforce`; `enforce` \| `monitor`                             |
| firedWindowKey | VARCHAR | NULL; webhook fire state (once per window)                                     |
| lastFiredAt | TIMESTAMP | NULL until first fire                                                          |
| createdAt / updatedAt | TIMESTAMP | NOT NULL                                                             |

Indexes: `(projectId)`, `(projectId, scope, scopeRef, metric)`.

### QuotaWindowCounter (requests metric only)

| Column    | Type      | Constraints                                    |
| --------- | --------- | ----------------------------------------------- |
| quotaId   | INTEGER   | FK → Quota, NOT NULL                            |
| windowKey | VARCHAR   | NOT NULL; truncated timestamp or `YYYY-MM`      |
| count     | BIGINT    | NOT NULL DEFAULT 0                              |
| updatedAt | TIMESTAMP | NOT NULL                                        |

Unique index: `(quotaId, windowKey)` — the atomic upsert/increment key.
No `publicId`: internal table, never exposed through the API. Expired rows
are garbage-collected opportunistically (delete `windowKey` older than the
window on increment).

Token/cost windows have **no counter table** — they aggregate `UsageMeter`
at check time, so quotas and metering can never disagree.

## REST API

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/api/v1/quotas`              | List quotas (`project_id` filter)            |
| POST   | `/api/v1/quotas`              | Create a quota                               |
| GET    | `/api/v1/quotas/{quota_id}`   | Get a quota, including current window usage  |
| PATCH  | `/api/v1/quotas/{quota_id}`   | Update `limit` / `mode`                      |
| DELETE | `/api/v1/quotas/{quota_id}`   | Delete a quota (drops its counters)          |

Bodies snake_case per platform convention; the OpenAPI spec
(`packages/server/src/rest/openapi/v1/quotas.yaml`) drives the generated
SDK, CLI manifest, and MCP tool surface.

## Permissions

| Permission            | Endpoint                                                    |
| --------------------- | ------------------------------------------------------------ |
| `quotas:ListQuotas`   | `GET /api/v1/quotas`                                         |
| `quotas:GetQuota`     | `GET /api/v1/quotas/{quota_id}`                              |
| `quotas:CreateQuota`  | `POST /api/v1/quotas`                                        |
| `quotas:UpdateQuota`  | `PATCH /api/v1/quotas/{quota_id}`                            |
| `quotas:DeleteQuota`  | `DELETE /api/v1/quotas/{quota_id}`                           |

Actions defined in `packages/server/src/permissions/quotas.json`.

## Implementation Phases

### Phase 1 — Requests Quotas + Middleware + 429 Contract ❌ Not started

**Deliverables:** `Quota` + `QuotaWindowCounter` models; quota CRUD (REST +
OpenAPI + SDK/CLI regen); the Koa middleware; `QUOTA_EXCEEDED` in
`errors/codes.ts`.

**Acceptance criteria:**

- Request N+1 within the window against a `limit: N`, `metric: requests`
  quota returns `429` with `Retry-After` and the exact `meta` shape above;
  request N returns normally.
- Two matching quotas (project-wide + API-key): breaching either blocks; the
  error body attributes the most specific one.
- Counters are correct under concurrency: a parallel-request test never
  admits more than `limit` (atomic increment proven, not assumed).
- CRUD covered for happy path, `401`, `403`, cross-project `404`.

### Phase 2 — Token/Cost Quotas at the Metering Choke Point ❌ Not started

**Depends on [usage metering Phase 1](./prd-usage-metering.md)** — without
`UsageMeter` rows there is nothing to aggregate; this phase does not start
until meter writes land.

**Deliverables:** pre-generation check in the provider-call wrapper;
`resets_at` computed from the oldest contributing meter for rolling windows.

**Acceptance criteria:**

- With a breached `cost_usd` quota, a new generation request returns `429
  QUOTA_EXCEEDED` and no `UsageMeter` row is written for it.
- A generation started *before* the breach completes and meters normally
  (in-flight work is never killed).
- `calendar_month` quota resets: a request in the next window key succeeds.

### Phase 3 — Monitor Mode, Webhooks, Formation Resource ❌ Not started

**Deliverables:** `quota.exceeded` webhook with once-per-window fire state;
monitor-mode audit entries; `QuotaResourceProperties` in `formations.yaml` +
`quotasFormationModule.ts`; module docs page.

**Acceptance criteria:**

- A `monitor` quota breach returns `200`, emits exactly one `quota.exceeded`
  delivery per window (second breach in the same window fires nothing), and
  writes an audit entry.
- Flipping `mode` to `enforce` via `PATCH` blocks the next breaching request.
- A formation template declaring a `quota` resource creates/updates/deletes
  it through the formation lifecycle; unknown fields are rejected with `400`.

## Risks

- **Fixed-window burst at boundaries** — up to 2× `limit` across a window
  edge. Accepted for v1 (documented); a sliding-window or token-bucket
  refinement is the noted future optimization.
- **Counter hot rows** — a single high-traffic key increments one row;
  Postgres row-lock contention caps throughput. Mitigation path: in-memory
  pre-aggregation flushing to the row.
- **Token/cost check races** — two concurrent generations both passing the
  pre-check can overshoot the budget by one generation each; bounded and
  accepted per the never-kill-in-flight decision.
- **Metering dependency slip** — Phase 2 is blocked on metering Phase 1;
  Phase 1 of this PRD is independent and can ship first.
