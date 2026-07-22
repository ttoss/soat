# PRD: Audit Log

> Generalizes the `ActivityEntry` audit record introduced in
> [guardrails](../packages/website/docs/modules/guardrails.md) — guardrail evaluation records
> become one `detail` kind of the entries defined here; this PRD defines the
> `detail->>'kind'` convention, the kind's schema is owned by the guardrails
> PRD — and provides the activity substrate
> [prd-approvals.md](./prd-approvals.md) assumes.

## Implementation Status

| Component                                          | Status         | Notes                                                            |
| -------------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| IAM SRN precision at `isAllowed` call sites        | ✅ Done        | Phase 0 — call sites pass `buildSrn` SRNs instead of `soat:{project}:*:*` |
| Request-id middleware (`X-Request-Id`)             | ✅ Done        | `middleware/requestId.ts` — `ctx.state.requestId` + `X-Request-Id` header |
| `AuditEntry` model (append-only, `audit_` prefix)  | ✅ Done        | `postgresdb/models/AuditEntry.ts` — model hooks reject UPDATE and single-row DELETE |
| Post-commit write hook at the authorization choke point | ✅ Done   | `middleware/audit.ts` wraps `isAllowed`/`resolveProjectIds`; fire-and-forget bounded queue (`lib/auditQueue.ts`) |
| Read API (`GET /api/v1/audit-log`, `/{entry_id}`)  | ✅ Done        | Filters: `action`, `actor_id`, `project_id`, `resource_public_id`, `resource_srn`, `from`/`to` |
| `audit` permission actions + policy wiring         | ✅ Done        | `permissions/audit.json` — `audit:ListAuditEntries`, `audit:GetAuditEntry` |
| Retention sweep (`AUDIT_RETENTION_DAYS`)           | ✅ Done        | `lib/auditScheduler.ts` — daily tick via the shared `createScheduler` pattern |

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

- **Read auditing in v1** — reads are high-volume and low-value; a possible
  future config flag, off by default.
- **SIEM integrations / dedicated export job** — NDJSON export works through
  the list endpoint's pagination; an `audit.entry_created` webhook event is a
  future-work sketch, push-to-SIEM stays out of scope.
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

**Decision: IAM precision ships first (Phase 0).** Before any audit code,
the call sites are upgraded to pass precise SRNs built with `buildSrn`. This
is a cross-cutting change to ~80 call sites with value independent of
auditing: today, policy statements scoped finer than a project are
effectively unenforceable because every check evaluates against the
wildcard. With precise SRNs at the choke point, the audit entry records the
real target from day one — `resourceSrn` is exact and `resourcePublicId` is
derived from its last segment. The one structural exception is **creates**:
the check runs before the resource exists, so create call sites target the
type (`soat:{project}:secret:*`) and the middleware captures
`resourcePublicId` from the response body `id` instead.

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
  to 10 calls). Rule: on a `403` response the **denied pair is primary** —
  it is the check that actually blocked the request, and labeling the entry
  with an earlier *allowed* action would misattribute the denial; otherwise
  the **first recorded call is primary** (it is the route's own permission
  check, made before any mutation). The remaining pairs are appended to
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
| `resourceSrn`      | string    | SRN the action targeted (`soat:{project}:{type}:{id}`; type-level `soat:{project}:{type}:*` on creates) — precise after Phase 0 |
| `resourcePublicId` | string    | Denormalized from the SRN's last segment; on creates, captured from the response body `id` |
| `status`           | integer   | HTTP status of the response (post-commit)                          |
| `requestId`        | string    | Per-request correlation id                                         |
| `ip`               | string    | Client IP                                                          |
| `userAgent`        | string    | Request `User-Agent`                                               |
| `detail`           | JSONB     | Kind-specific payload; guardrail evaluation records live here      |
| `createdAt`        | timestamp | Only timestamp — rows are immutable                                |

Indexes: `(projectId, createdAt)`, `(actorId, createdAt)`,
`(action, createdAt)`, `(resourcePublicId, createdAt)` — the last one is the
per-resource lookup key (an exact-id lookup, cheaper than a `resourceSrn`
prefix scan).

**Append-only:** no update/delete lib functions, no REST mutation routes, and
model-layer hooks reject `UPDATE`/`DELETE`.

## REST API

Bodies snake_case; path params `{entry_id}`. MCP tools, SDK, and CLI derive
automatically from `packages/server/src/rest/openapi/v1/audit-log.yaml`.

| Method | Path                              | Description                                                                                     |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/audit-log`               | List entries. Filters: `action`, `actor_id`, `project_id`, `resource_public_id` (exact), `resource_srn` (prefix match, e.g. `soat:{project}:secret:` for all secret actions), `from`, `to`; cursor pagination |
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

### Phase 0 — IAM SRN Precision (prerequisite) ✅ Done

Upgrade the ~80 `isAllowed` call sites from `soat:{project}:*:*` to precise
SRNs built with `buildSrn`: `soat:{project}:{type}:{id}` for operations on
an existing resource, `soat:{project}:{type}:*` for creates and lists. No
audit code in this phase — it stands alone and makes resource-level policy
statements enforceable, which is why it ships regardless of the audit log.

**Acceptance criteria:**

- A policy allowing `secrets:GetSecret` on `soat:{project}:secret:{sec_a}`
  permits reading `sec_a` and denies reading `sec_b` (today both would be
  allowed or both denied).
- No call site passes `soat:{project}:*:*` except where the project itself
  is the target (e.g. `projects:*` actions).
- Existing project-wildcard policy documents keep working unchanged
  (`soat:{project}:*:*` patterns still match precise SRNs).

### Phase 1 — Request Id + Table + Write Hook + Read API + Retention ✅ Done

Request-id middleware (prerequisite), model, `audit_` prefix, `isAllowed`
wrapper + post-commit middleware, bounded queue, read routes, retention
sweep, OpenAPI spec, permission JSON, SDK/CLI regeneration.

**Acceptance criteria:**

- Every `/api/v1` response carries an `X-Request-Id` header, and audit
  entries record the same id.
- Creating then deleting a secret yields exactly two entries with actions
  `secrets:CreateSecret` / `secrets:DeleteSecret`, statuses `201` / `200`,
  SRNs `soat:{project}:secret:*` (create — type-level) and
  `soat:{project}:secret:{sec_…}` (delete), and `resource_public_id` set to
  the secret's `sec_…` id on both — from the response body on the create,
  from the SRN on the delete.
- A user without `secrets:DeleteSecret` attempting the delete yields one
  entry with `status: 403` and the same action string.
- A route that makes multiple `isAllowed` calls produces one entry: on
  success the primary `action` is the first (route-level) check; on `403`
  the primary is the denied pair; the remaining pairs land in
  `detail.additional_checks`.
- `GET /api/v1/audit-log?action=secrets:DeleteSecret` returns both delete
  entries and nothing else; `?resource_public_id=sec_…` returns only that
  secret's entries; unauthenticated → `401`, no `audit:*` permission → `403`.
- GET requests write no entries — including the `isAllowed` calls made
  internally by `resolveProjectIds` for list scoping. Killing the DB
  connection inside the audit writer does not change any request's response.
- With `AUDIT_RETENTION_DAYS=1`, a backdated row is gone after one sweep
  tick; a fresh row survives.

### Future work (not planned)

- **Guardrail evaluations as `detail.kind = "guardrail_evaluation"`** —
  owned by [guardrails](../packages/website/docs/modules/guardrails.md); this PRD only defines
  the `detail->>'kind'` convention such entries must follow.
- **Read auditing** — per-project config flag, off by default.
- **`audit.entry_created` webhook event** — through the existing webhooks
  module.
- **Tamper evidence** — hash-chaining entries.

## Decisions

| Decision | Rationale |
| --- | --- |
| Action vocabulary = permission registry | Zero new vocabulary to maintain; the IAM layer already knows the exact action string at the choke point |
| IAM SRN precision ships first (Phase 0) | Wildcard checks make sub-project policy statements unenforceable and would force the audit log to record `soat:{project}:*:*` for every entry; fixing the ~80 call sites first means the log records real targets from day one |
| Primary pair: denied check on `403`, first check otherwise; rest go to `detail.additional_checks` | The denied check is what actually blocked the request — labeling the entry with an earlier allowed action would misattribute the denial; on success the first call is the route's own permission check. Multi-check routes (e.g. triggers) lose no decisions |
| Ship request-id middleware as part of Phase 1 | The `requestId` column has no existing source — nothing in the server generates a correlation id today |
| Write post-commit, with response status | Prevents false success records; the status is part of the fact being audited |
| Fire-and-forget bounded queue | Auditing must never block or fail the request it describes |
| Log denied (403) attempts | Denials are the highest-signal entries in a forensic review |
| Mutations only in v1 | Reads are high-volume/low-value; opt-in flag later keeps the table useful, not noisy |
| `detail` JSONB, not per-kind tables | Guardrails, approvals, and future kinds share one queryable stream (`detail->>'kind'`) |

## Risks

- **Phase 0 gates everything** — the audit log now waits on a cross-cutting
  change to ~80 call sites; scope creep there delays the log indefinitely.
  Mitigation: Phase 0 is mechanical per call site (swap the wildcard for
  `buildSrn` with ids the route already has in scope), can land
  module-by-module, and existing wildcard policies keep matching — but
  Phase 1 must not start until it is complete, or early entries would mix
  wildcard and precise SRNs.
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
