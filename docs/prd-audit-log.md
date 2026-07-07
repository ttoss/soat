# PRD: Audit Log

> Generalizes the `ActivityEntry` audit record introduced in
> [prd-guardrails.md](./prd-guardrails.md) (guardrail evaluation records
> become one `detail` kind of the entries defined here) and provides the
> activity substrate [prd-approvals.md](./prd-approvals.md) assumes.

## Implementation Status

| Component                                          | Status         | Notes                                                            |
| -------------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `AuditEntry` model (append-only, `audit_` prefix)  | ❌ Not started | No UPDATE/DELETE path, enforced at the model layer               |
| Post-commit write hook at the authorization choke point | ❌ Not started | Wraps `ctx.authUser.isAllowed`; fire-and-forget, bounded queue |
| Read API (`GET /api/v1/audit-log`, `/{entry_id}`)  | ❌ Not started | Filters: `action`, `actor_id`, `resource_srn`, `from`/`to`       |
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
  reconstruct the request (action, target SRN, status, IP, request id).
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

That call is the choke point. The write hook wraps `isAllowed` to record the
authorized `(action, resource)` pair on the request context; an outer
middleware then writes the `AuditEntry` **after the response is committed**,
stamping the final HTTP status — post-commit because an entry claiming success
for a request that later failed validation would be a false record.
**Denied attempts are logged too** (status 403): denials are the most valuable
entries in a forensic review — they show who *tried*.

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
| `resourceSrn`      | string    | SRN the action targeted (`soat:{project}:{type}:{id}`)             |
| `resourcePublicId` | string    | Denormalized target id for direct lookup                           |
| `status`           | integer   | HTTP status of the response (post-commit)                          |
| `requestId`        | string    | Per-request correlation id                                         |
| `ip`               | string    | Client IP                                                          |
| `userAgent`        | string    | Request `User-Agent`                                               |
| `detail`           | JSONB     | Kind-specific payload; guardrail evaluation records live here      |
| `createdAt`        | timestamp | Only timestamp — rows are immutable                                |

Indexes: `(projectId, createdAt)`, `(actorId, createdAt)`,
`(action, createdAt)`.

**Append-only:** no update/delete lib functions, no REST mutation routes, and
model-layer hooks reject `UPDATE`/`DELETE`.

## REST API

Bodies snake_case; path params `{entry_id}`. MCP tools, SDK, and CLI derive
automatically from `packages/server/src/rest/openapi/v1/audit-log.yaml`.

| Method | Path                              | Description                                                                                     |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/audit-log`               | List entries. Filters: `action`, `actor_id`, `resource_srn` (prefix match), `from`, `to`; cursor pagination |
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

### Phase 1 — Table + Write Hook + Read API ❌ Not started

Model, `audit_` prefix, `isAllowed` wrapper + post-commit middleware, bounded
queue, read routes, OpenAPI spec, permission JSON, SDK/CLI regeneration.

**Acceptance criteria:**

- Creating then deleting a secret yields exactly two entries with actions
  `secrets:CreateSecret` / `secrets:DeleteSecret`, correct
  `soat:{project}:secret:{sec_…}` SRNs, and statuses `201` / `200`.
- A user without `secrets:DeleteSecret` attempting the delete yields one
  entry with `status: 403` and the same action string.
- `GET /api/v1/audit-log?action=secrets:DeleteSecret` returns both delete
  entries and nothing else; unauthenticated → `401`, no `audit:*` permission
  → `403`.
- GET requests write no entries. Killing the DB connection inside the audit
  writer does not change any request's response.

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
| Action vocabulary = permission registry | Zero new vocabulary to maintain; the IAM layer already knows the exact string at the choke point |
| Write post-commit, with response status | Prevents false success records; the status is part of the fact being audited |
| Fire-and-forget bounded queue | Auditing must never block or fail the request it describes |
| Log denied (403) attempts | Denials are the highest-signal entries in a forensic review |
| Mutations only in v1 | Reads are high-volume/low-value; opt-in flag later keeps the table useful, not noisy |
| `detail` JSONB, not per-kind tables | Guardrails, approvals, and future kinds share one queryable stream (`detail->>'kind'`) |

## Risks

- **Write amplification** — every mutation adds one INSERT; mitigated by the
  async queue and the three narrow indexes.
- **Silent drop under overflow** — bounded queue can lose entries at extreme
  load; acceptable for v1, surfaced as a counter; tamper-evident/guaranteed
  delivery is future work.
- **Choke-point coverage gaps** — routes that mutate without an `isAllowed`
  call (bootstrap, login) write no entry; Phase 1 must enumerate and
  explicitly hook or exempt them.
- **Guardrails schema drift** — the `detail` kind is owned by the guardrails
  PRD; a shared schema fixture in tests keeps the two in lockstep.
