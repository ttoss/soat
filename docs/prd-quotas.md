# PRD: Quotas & Rate Limiting

> Part of [Agent Operations on Formations](./prd-agent-operations.md).
> Depends on the meter-write choke point from
> [prd-usage-metering.md](./prd-usage-metering.md) (Phase 1) for token/cost
> windows; complements the per-action classification in
> [prd-guardrails.md](./prd-guardrails.md).

> **Counted-identity decision (2026-07).** The request-quota middleware counts
> **API-key-authenticated requests only** in v1. JWT-user requests are never
> counted or blocked — interactive users are not the runaway surface (see
> Non-goals), and exempting them removes both the pre-handler
> project-resolution problem (a project key binds to exactly one project, so
> `(principal, project)` is known after `auth` with no per-route parsing) and
> the lockout hazard (an admin with a JWT can always `PATCH` a quota back up
> while the project's keys are being `429`'d). Implement the middleware as a
> two-step seam — *resolve `(principal, project)` → match quotas* — so future
> principal types (JWT users, per-user quotas) are a new resolver branch, not
> a redesign. A `scope: project` quota therefore means "all API keys of this
> project" for the `requests` metric.

> **Scope×metric validity decision (2026-07).** `scope: agent` combined with
> `metric: requests` is **rejected with `400`** at create/update. An agent's
> activity is not inbound HTTP traffic, and no precise per-request agent
> attribution exists pre-handler; shipping a vague semantic would have to be
> honored forever, while adding a precise one later (e.g.
> "generation-starting requests") is backward-compatible. `agent` scope is
> valid for `tokens` / `cost_usd` (Phase 2).

> **API-key token/cost decision (2026-07, Phase 2).** Symmetrically,
> `scope: api_key` combined with `metric: tokens` / `cost_usd` is **rejected
> with `400`**. The token/cost check aggregates `UsageEvent`, which carries
> project and agent attribution but **no API-key column** — so an API-key
> token/cost cap could never be aggregated and would be a silent no-op. The
> honest choice (same as agent+requests) is to reject it rather than store a
> cap nobody enforces; a precise semantic can be added later, backward
> compatibly, once metering attributes spend to an API key. Phase 2 therefore
> enforces token/cost for `project` and `agent` scopes only.

> **Failure-mode decision (2026-07).** On infrastructure failure (the counter
> `UPDATE`/upsert itself errors), the middleware **fails open**: the request
> proceeds and the error is logged loudly. The PRD's "fail closed" wording
> refers to breach semantics (any breached `enforce` quota blocks), not DB
> errors — quotas are cost control, not authorization, and the worst case of
> fail-open (one window of unmetered spend) is strictly better than the worst
> case of fail-closed (a platform-wide outage caused by the rate limiter). A
> short-TTL circuit breaker to shed counter writes from a struggling DB is a
> noted future hardening, not a v1 requirement.

> **Increment semantics decision (2026-07).** Every request that reaches the
> middleware increments the counter, **including requests subsequently
> rejected** (`429`, `403`, `404`, …). The atomic
> `UPDATE … SET count = count + 1 … RETURNING count` is simultaneously the
> increment and the check — one statement, no read-then-write race; any
> "don't count rejected requests" variant needs a second round-trip or a
> compensating decrement, which is slower and racy for negligible benefit
> under fixed windows (the counter resets at the window edge regardless).

> **Uniqueness & referential-integrity decision (2026-07).** A partial unique
> index on `(projectId, scope, scopeRef, metric, window)` prevents duplicate
> quotas (the all-enforce precedence rule makes duplicates pure redundancy);
> creating a duplicate returns `409`. `scope_ref` is validated to reference
> an existing API key / agent **in the same project** at create/update time;
> it is a soft reference (no FK). When the referenced entity is later
> deleted, the quota **goes inert — it is not cascade-deleted**: silently
> dropping a spend cap as a side effect of deleting a key is an invisible
> safety regression, while a dangling quota is harmless (public ids are never
> reused) and visible/deletable via the API.

> **Self-modification decision (2026-07).** No special-case rule prevents an
> API-key principal from mutating quotas that match its own scope —
> enforcement stays in IAM (`quotas:*` actions), and the module docs must
> call out the footgun: do **not** grant `quotas:UpdateQuota` /
> `quotas:DeleteQuota` to autonomous principals whose spend the quota is
> meant to cap. The composable long-term gate already exists in the platform:
> quota mutations are ordinary actions, so operators can route them through a
> class-C guardrail → approval flow (G4/G3) rather than a bespoke carve-out
> in this module.

> **Contract-detail decisions (2026-07).** `limit` must be a positive
> **integer** when `metric: requests` (`400` otherwise); fractional limits
> remain valid for `cost_usd` (and `tokens` limits are integers too). In
> Phase 1, `mode: monitor` is **accepted and stored but is a pass-through
> no-op** — the `quota.exceeded` webhook and audit entries land in Phase 3
> with no schema migration; monitor quotas created earlier simply start
> reporting when Phase 3 ships.

## Implementation Status

| Component                                   | Status         | Notes                                                        |
| ------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `Quota` model + CRUD                        | ❌ Not started | Project-scoped; scope/metric/window/limit/mode                |
| `QuotaWindowCounter` table                  | ❌ Not started | Per-window fixed counters for `requests`                      |
| Request-quota Koa middleware                | ❌ Not started | After auth, before handlers; atomic `UPDATE ... RETURNING`    |
| `QUOTA_EXCEEDED` error code + `429` contract | ❌ Not started | `Retry-After` header; registered in `errors/codes.ts`         |
| Token/cost check at meter-write choke point | ✅ Shipped     | Pre-generation check (`project`/`agent` scopes); never kills an in-flight generation |
| `quota.exceeded` webhook event              | ✅ Shipped     | First breach per fixed window; fires for enforce + monitor    |
| Monitor mode (fire, don't block)            | ✅ Shipped     | Breach fires the webhook without blocking; flip to enforce via PATCH |
| Monitor-mode audit entries                  | ⏭️ Deferred    | Owned by the (unbuilt) audit-log module; webhook is the interim signal |
| `quota` formation resource type             | ✅ Shipped     | `QuotaResourceProperties` + `quotasFormationModule`           |

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

### Phase 2 — Token/Cost Quotas at the Metering Choke Point ✅ Shipped

**Depended on [usage metering Phase 1](./prd-usage-metering.md)** — now shipped,
so there are `UsageEvent` rows to aggregate.

**Deliverables (shipped):** `evaluateGenerationQuotas` runs at the top of
`createGeneration` (the single provider-call wrapper), before any context
building or provider call. It aggregates the current fixed window from
`UsageEvent` (summing priced cost for `cost_usd`, billable token components for
`tokens`), matches `project`- and `agent`-scoped `enforce` quotas, and throws
`QUOTA_EXCEEDED` on a breach via the shared `quotaBreachError`. The
`errorLogger` middleware emits the `Retry-After` header from the error's
`resets_at` so the generation path honors the same 429 contract as the request
middleware. Windows are fixed (consistent with the requests metric): `resets_at`
is the start of the next fixed window, not a per-meter slide.

**Acceptance criteria (met):**

- With a breached `cost_usd`/`tokens` quota, a new generation returns `429
  QUOTA_EXCEEDED` (with `Retry-After`) and no `UsageEvent` row is written for it.
- A generation started *before* the breach completes and meters normally
  (the check inspects prior usage only — in-flight work is never killed).
- `calendar_month` (and every rolling) window resets: usage outside the current
  fixed window is not counted, so the next window admits the generation.
- `api_key`-scoped token/cost quotas are rejected at create time (no
  attribution to aggregate); the evaluator also skips any stray one defensively.

### Phase 3 — Monitor Mode, Webhooks, Formation Resource ✅ Shipped

**Deliverables (shipped):** `quota.exceeded` webhook (`quotaEvents.ts`) with
once-per-window fire state on the `Quota.firedWindowKey` column, fired from both
enforcement points for `enforce` and `monitor` quotas; monitor mode evaluated
alongside enforce (fires the webhook, never blocks); `QuotaResourceProperties`
in `formations.yaml` + `quotasFormationModule.ts` (registered); module docs.

**Fire-state note:** a quota's window always has a discrete fixed key (rolling
windows are fixed-keyed) and usage only grows within a key, so the fire state is
a single stored key — no sliding-window hysteresis is needed (unlike usage
thresholds).

**Audit entries — deferred.** The original criterion "writes an audit entry" is
owned by the **audit-log module** (a separate, not-yet-started initiative — no
`AuditEntry` model exists). The `quota.exceeded` webhook is the interim durable
signal for a monitor breach; a persisted audit record lands when audit-log ships
(tracked as the roadmap's activity-feed / audit ownership reconciliation).

**Acceptance criteria (met):**

- A `monitor` quota breach returns `200` (request) / proceeds (generation) and
  emits exactly one `quota.exceeded` delivery per window (a second breach in the
  same window fires nothing).
- An `enforce` breach fires the same webhook once per window in addition to the
  `429`.
- Flipping `mode` to `enforce` via `PATCH` blocks the next breaching request.
- A formation template declaring a `quota` resource creates/updates/deletes it
  through the formation lifecycle; unknown fields are rejected with `400`.

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
