# PRD: Audit Log

> Generalizes the `ActivityEntry` audit record introduced in
> [prd-guardrails.md](./prd-guardrails.md) (guardrail evaluation records
> become one `detail` kind of the entries defined here) and provides the
> activity substrate [prd-approvals.md](./prd-approvals.md) assumes.

## Implementation Status

| Component                                          | Status         | Notes                                                            |
| -------------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| Request-id middleware (`X-Request-Id`)             | ❌ Not started | Prerequisite — nothing in the server generates a request id today |
| `AuditEntry` model (append-only, `audit_` prefix)  | ❌ Not started | No UPDATE/DELETE path, enforced at the model layer               |
| Post-commit write hook at the authorization choke point | ❌ Not started | Wraps `ctx.authUser.isAllowed`; fire-and-forget, bounded queue |
| Read API (`GET /api/v1/audit-log`, `/{entry_id}`)  | ❌ Not started | Filters: `action`, `actor_id`, `resource_public_id`, `resource_srn`, `from`/`to` |
| `audit` permission actions + policy wiring         | ❌ Not started | `audit:ListAuditEntries`, `audit:GetAuditEntry`                  |
| Guardrails `ActivityEntry` as a `detail` kind      | ❌ Not started | Depends on [prd-guardrails.md](./prd-guardrails.md) Phase 3      |
| Retention sweep (`AUDIT_RETENTION_DAYS`)           | ❌ Not started | Daily tick, `orchestrationScheduler` interval pattern            |
| Read-audit config flag                             | ❌ Not started | Future phase; off by default                                     |
| `audit.entry_created` webhook event                | ❌ Not started | Optional future phase                                            |

## Problem

Pieces of an audit trail exist implicitly — webhook delivery records,
formation events, traces/generations, and the guardrails PRD's planned
`ActivityEntry` — but there is no unified, queryable answer to *"who did what
to the platform"*: who changed this policy, who deleted that secret, who
rotated a webhook secret, who created an API key. Enterprise and self-hosted
adopters expect this record as table stakes, and the guardrails and approvals
PRDs already assume an activity substrate (`activity.actions_24h` guard
context) that nothing currently writes.

## Goals

- One append-only table recording every mutating administrative and resource
  action, attributed to a principal (user or API key), with enough context to
  reconstruct the request (action, target id + SRN, status, IP, request id).
- **Zero new vocabulary:** the audit action string *is* the permission-action
  string that authorized the request.
- A filterable read API from which the SDK, CLI, and MCP surfaces derive
  automatically via the OpenAPI spec.
- The guardrails evaluation record lands as one `detail` kind, not a parallel
  table.

## Non-goals

- **Agent/LLM runtime behavior** — that is the traces/generations module:

  | Question                                   | Module    |
  | ------------------------------------------ | --------- |
  | What did the agent do inside a run?        | Traces    |
  | What did a principal do to the platform?   | Audit log |

- **Read auditing in v1** — reads are high-volume and low-value; a config
  flag in Phase 3, off by default.
- **SIEM integrations / dedicated export job** — NDJSON export works through
  the list endpoint's pagination; an `audit.entry_created` webhook event is a
  Phase 3 sketch, push-to-SIEM stays out of scope.
- **Tamper evidence** — hash-chaining entries is a one-line future sketch,
  not v1.

## Key Design: the Permission Registry Is the Vocabulary

Every route already authorizes through
`ctx.authUser.isAllowed({ projectPublicId, action, resource })` — the
functions built by `createApiKeyIsAllowed` / `createJwtIsAllowed` in
`packages/server/src/lib/permissions.ts` and attached in
`packages/server/src/middleware/auth.ts`. The `action` argument is always a
`module:Action` string from `packages/server/src/permissions/*.json`
(e.g. `secrets:DeleteSecret`), and `resource` is an SRN in the
`soat:{project}:{type}:{id}` format from `buildSrn` in
`packages/server/src/lib/iam.ts`.

That call is the choke point — with one important caveat. The `action`
string is always exact, but the `resource` argument is **not**: nearly every
call site in the codebase passes the project-wildcard SRN
`soat:{project}:*:*` rather than the specific target (e.g.
`packages/server/src/rest/v1/secrets.ts` checks `secrets:DeleteSecret`
against `soat:${secret.projectId}:*:*`). The choke point therefore reliably
knows *action + project*, not the individual resource.

**v1 resolution:** keep the wildcard `resourceSrn` as-recorded (it is the
fact of what authorization evaluated), and have the audit middleware
denormalize the actual target into `resourcePublicId` from the request
itself — any `*_id` route param, or the response body `id` on creates.
Upgrading call sites to pass precise SRNs is deferred to a separate
IAM-granularity effort (it has independent value: today, policy statements
scoped finer than a project are effectively unenforceable because checks
always use wildcards — but it is a cross-cutting change to ~80 call sites
and must not gate this module).

The write hook wraps `ctx.authUser.isAllowed` **after** `authMiddleware`
attaches it, recording each authorized `(action, resource)` pair on the
request context; an outer middleware then writes the `AuditEntry` **after
the response is committed**, stamping the final HTTP status — post-commit
because an entry claiming success for a request that later failed validation
would be a false record. **Denied attempts are logged too** (status 403):
denials are the most valuable entries in a forensic review — they show who
*tried*.

Two wrapping details matter:

- **Multiple `isAllowed` calls per request.** Several routes check more than
  one action per request (`packages/server/src/rest/v1/triggers.ts` makes up
  to 10 calls). Rule: the **first recorded call is the primary** — it is the
  route's own permission check, made before any mutation — and produces the
  entry's `action`/`resourceSrn`; subsequent pairs are appended to
  `detail.additional_checks` so no decision is lost.
- **Resolver-internal checks are excluded by construction.** The
  `resolveProjectIds` helpers (`authProjectResolvers.ts`) call `isAllowed`
  internally for list scoping, but they capture the *unwrapped* function in
  a closure when `authMiddleware` builds `ctx.authUser` — so wrapping
  `ctx.authUser.isAllowed` after attachment naturally records only
  route-level checks. A test must pin this property so a future auth
  refactor doesn't silently flood the log with read-scoping noise.

**Prerequisite:** the `requestId` column assumes a per-request correlation
id, but no request-id middleware exists in the server today. Phase 1 ships
one first: generate a nanoid per request, expose it as `ctx.state.requestId`,
and echo it in an `X-Request-Id` response header.

Writes are **fire-and-forget through a bounded in-process queue**: auditing
must never block or fail the request it describes; on overflow, drop and count
(a metric, not an exception).

## Data Model

`AuditEntry` — publicId prefix `audit_` (registered in
`packages/postgresdb/src/utils/publicId.ts`; no collision with existing
prefixes).

| Column             | Type      | Notes                                                              |
| ------------------ | --------- | ------------------------------------------------------------------ |
| `publicId`         | string    | `audit_{16-char nanoid}`                                           |
| `projectId`        | FK, null  | Nullable — global actions (e.g. `users:CreateUser`) have no project |
| `actorType`        | string    | `user` \| `api_key`                                                |
| `actorId`          | string    | Public id of the principal (`user_…` / `key_…`)                    |
| `action`           | string    | The permission-action string that authorized the request           |
| `resourceSrn`      | string    | SRN as evaluated by `isAllowed` — in v1 this is the project-wildcard `soat:{project}:*:*` at nearly all call sites |
| `resourcePublicId` | string    | Denormalized target id, captured by the middleware from `*_id` route params or the response body `id` on creates |
| `status`           | integer   | HTTP status of the response (post-commit)                          |
| `requestId`        | string    | Per-request correlation id                                         |
| `ip`               | string    | Client IP                                                          |
| `userAgent`        | string    | Request `User-Agent`                                               |
| `detail`           | JSONB     | Kind-specific payload; guardrail evaluation records live here      |
| `createdAt`        | timestamp | Only timestamp — rows are immutable                                |

Indexes: `(projectId, createdAt)`, `(actorId, createdAt)`,
`(action, createdAt)`, `(resourcePublicId, createdAt)` — the last one because
`resourcePublicId`, not the wildcard `resourceSrn`, is the per-resource
lookup key in v1.

**Append-only:** no update/delete lib functions, no REST mutation routes, and
model-layer hooks reject `UPDATE`/`DELETE`.

## REST API

Bodies snake_case; path params `{entry_id}`. MCP tools, SDK, and CLI derive
automatically from `packages/server/src/rest/openapi/v1/audit-log.yaml`.

| Method | Path                              | Description                                                                                     |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/audit-log`               | List entries. Filters: `action`, `actor_id`, `resource_public_id` (exact), `resource_srn` (prefix match — project-level resolution in v1), `from`, `to`; cursor pagination |
| GET    | `/api/v1/audit-log/{entry_id}`    | Fetch one entry, including `detail`                                                             |

## Permissions

| Permission                | Endpoint                          |
| ------------------------- | --------------------------------- |
| `audit:ListAuditEntries`  | `GET /api/v1/audit-log`           |
| `audit:GetAuditEntry`     | `GET /api/v1/audit-log/{entry_id}` |

## Retention

`AUDIT_RETENTION_DAYS` (default `365`). A daily sweep deletes rows older than
the cutoff, using the same `setInterval` tick pattern as
`startOrchestrationScheduler` in
`packages/server/src/lib/orchestrationScheduler.ts` (safe under overlapping
ticks and multiple workers). Export before expiry = paginate the list endpoint
into NDJSON; no dedicated export job in v1.

## Implementation Phases

### Phase 1 — Request Id + Table + Write Hook + Read API ❌ Not started

Request-id middleware (prerequisite), model, `audit_` prefix, `isAllowed`
wrapper + post-commit middleware, bounded queue, read routes, OpenAPI spec,
permission JSON, SDK/CLI regeneration.

**Acceptance criteria:**

- Every `/api/v1` response carries an `X-Request-Id` header, and audit
  entries record the same id.
- Creating then deleting a secret yields exactly two entries with actions
  `secrets:CreateSecret` / `secrets:DeleteSecret`, statuses `201` / `200`,
  `resource_srn` matching what authorization evaluated
  (`soat:{project}:*:*` in v1), and `resource_public_id` set to the
  secret's `sec_…` id — from the response body on the create, from the
  route param on the delete.
- A user without `secrets:DeleteSecret` attempting the delete yields one
  entry with `status: 403` and the same action string.
- A route that makes multiple `isAllowed` calls produces one entry whose
  `action` is the first (route-level) check, with the remaining pairs in
  `detail.additional_checks`.
- `GET /api/v1/audit-log?action=secrets:DeleteSecret` returns both delete
  entries and nothing else; `?resource_public_id=sec_…` returns only that
  secret's entries; unauthenticated → `401`, no `audit:*` permission → `403`.
- GET requests write no entries — including the `isAllowed` calls made
  internally by `resolveProjectIds` for list scoping. Killing the DB
  connection inside the audit writer does not change any request's response.

### Phase 2 — Guardrails Detail Kind + Retention ❌ Not started

Guardrail evaluations write entries with
`detail.kind = "guardrail_evaluation"` per the schema in
[prd-guardrails.md](./prd-guardrails.md) (dependency: its Phase 3);
retention sweep ships.

**Acceptance criteria:**

- A guarded tool call produces an entry whose `detail` round-trips the
  guardrails one-query audit (`policy_id`, `policy_version`, `decision`).
- With `AUDIT_RETENTION_DAYS=1`, a backdated row is gone after one sweep
  tick; a fresh row survives.

### Phase 3 — Read Auditing Flag + Webhook ❌ Not started

Per-project read-audit config flag (default off); `audit.entry_created`
webhook event through the existing webhooks module.

**Acceptance criteria:**

- Flag off: GETs write nothing. Flag on: a `secrets:GetSecret` read writes
  one entry.
- A subscribed webhook receives one delivery per new entry.

## Decisions

| Decision | Rationale |
| --- | --- |
| Action vocabulary = permission registry | Zero new vocabulary to maintain; the IAM layer already knows the exact action string at the choke point |
| Wildcard `resourceSrn` + denormalized `resourcePublicId` in v1 | Call sites pass `soat:{project}:*:*`, not specific SRNs; recording what was actually evaluated keeps the entry honest, while the route param / response id gives per-resource lookup. Precise SRNs are a separate IAM-granularity effort |
| First `isAllowed` call is the primary; rest go to `detail.additional_checks` | The first call is the route's own permission check, made before any mutation; multi-check routes (e.g. triggers) lose no decisions |
| Ship request-id middleware as part of Phase 1 | The `requestId` column has no existing source — nothing in the server generates a correlation id today |
| Write post-commit, with response status | Prevents false success records; the status is part of the fact being audited |
| Fire-and-forget bounded queue | Auditing must never block or fail the request it describes |
| Log denied (403) attempts | Denials are the highest-signal entries in a forensic review |
| Mutations only in v1 | Reads are high-volume/low-value; opt-in flag later keeps the table useful, not noisy |
| `detail` JSONB, not per-kind tables | Guardrails, approvals, and future kinds share one queryable stream (`detail->>'kind'`) |

## Risks

- **Write amplification** — every mutation adds one INSERT; mitigated by the
  async queue and the four narrow indexes.
- **Silent drop under overflow** — bounded queue can lose entries at extreme
  load; acceptable for v1, surfaced as a counter; tamper-evident/guaranteed
  delivery is future work.
- **Choke-point coverage gaps** — mutations the post-commit HTTP middleware
  never sees. Phase 1 must enumerate and explicitly hook or exempt each:
  - **Bootstrap and login** — mutate without an `isAllowed` call.
  - **Trigger dispatch** — `triggerDispatch.ts` calls `isAllowed` outside
    any HTTP request context, so its mutations bypass the middleware
    entirely; hooking it needs a direct enqueue at the dispatch site.
  - **Formation apply** — one `formations:*` authorization fans out into
    many resource mutations via the formation modules, so per-resource
    attribution is lost; v1 records the single formations-level entry and
    accepts the coarseness.
  - MCP is **covered**: MCP tool handlers forward the bearer token to the
    REST layer, so those requests flow through the same middleware.
- **Guardrails schema drift** — the `detail` kind is owned by the guardrails
  PRD; a shared schema fixture in tests keeps the two in lockstep.
