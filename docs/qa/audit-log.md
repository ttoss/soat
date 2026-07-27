# QA checklist — audit-log

Module docs: [`packages/website/docs/modules/audit-log.md`](../../packages/website/docs/modules/audit-log.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-25 | live server `soat.naturali.ai`, project `proj_ck7jvYsjVKI9UHCG`, project-scoped API key, repo `main` @ `636a277` | 36/37 checks pass | [#707](https://github.com/ttoss/soat/issues/707) — non-numeric `limit`/`offset` → 500 (fixed) |
| 2026-07-27 | live server `soat.naturali.ai`, **admin** credential (the 07-25 blocker) | 42/45 — the global-entries item is now a confirmed defect rather than an unreached one | [#745](https://github.com/ttoss/soat/issues/745) — identity/authz mutations are never audited; no global entry has ever been written |

## Read API — list

- [x] `GET /audit-log?project_id=` returns entries **newest-first**, envelope `{data, limit, offset, total}`
- [x] `action` filter — exact match
- [x] `principal_id` filter — exact match; unknown principal returns 0 rows
- [x] `resource_public_id` filter — exact match
- [x] `resource_srn` filter — **prefix** match (`soat:{proj}:secret:` matches both type-level create rows and item rows)
- [x] `from` / `to` date-range filters
- [x] Invalid `from` / `to` → `400 VALIDATION_FAILED`
- [x] Pagination: default `limit` 25; `≤0` → 1; `>200` → 200; negative `offset` → 0
- [x] Non-numeric `limit` / `offset` → `400 VALIDATION_FAILED`, not `500` (was [#707](https://github.com/ttoss/soat/issues/707))
- [x] `limit=1e3`, `limit=5.5`, `limit=`, `offset=2.7` coerce without error
- [x] Unknown project → `403`; unauthenticated → `401`; bogus token → `401`

## Read API — get

- [x] `GET /audit-log/{id}` returns the full entry including `detail`
- [x] Unknown id → `404`
- [x] Separately authorized — a key with `audit:ListAuditEntries` but not `audit:GetAuditEntry` gets `403`

## Recording — mutations

- [x] **Create** → type-level SRN (`soat:{proj}:secret:*`), `resource_public_id` captured from the response body, `status: 201`
- [x] **Update** (PATCH) → precise SRN (`…:secret:sec_…`), `status: 200`
- [x] **Delete** → precise SRN, `status: 204`
- [x] **`403` denials recorded** with the denied action and the denied principal
- [x] Non-2xx outcomes recorded generally (`400`, `409` present in history)

## Multiple checks per request

- [x] Success → exactly **one** entry; primary `action` is the route-level check; the second check lands in `detail.additional_checks` as `{action, resource, allowed}`
- [x] `403` → primary is the **denied** check, not the earlier allowed one

```jsonc
// POST /triggers with a key allowed triggers:CreateTrigger but not the agent start permission
{ "action": "agents:CreateAgentGeneration", "status": 403,
  "resource_srn": "soat:proj_…:agent:agent_…",
  "detail": { "additional_checks": [
    { "action": "triggers:CreateTrigger", "allowed": true, "resource": "soat:proj_…:trigger:*" } ] } }
```

## Request correlation

- [x] `X-Request-Id` returned on every response
- [x] A caller-supplied `X-Request-Id` is honored and stored verbatim in `request_id`
- [x] A UUID is generated when the caller supplies none

## Read auditing

- [x] Flag off (default) → `GET` produces no entry
- [x] Flag on → `secrets:GetSecret` and `secrets:ListSecrets` recorded with correct SRN and status
- [x] **Unscoped** list read (`GET /secrets` with no `project_id`) never recorded, flag on
- [x] Flag off again → takes effect immediately on the serving instance

## NDJSON export

- [x] `content-type: application/x-ndjson` + `content-disposition: attachment; filename="audit-log-{proj}.ndjson"`
- [x] One valid JSON object per line — **oldest-first**
- [x] Field parity with the read API (identical 13-key set)
- [x] `project_id` required → `400 project_id is required`
- [x] List filters apply identically
- [x] `detail` **inner** keys are snake_case and match the read API byte-for-byte
- [x] Separately authorized — list-only key gets `403` on `audit:ExportAuditEntries`
- [x] `limit` / `offset` ignored entirely by the export endpoint (so it never hit the #707 crash)

## `audit.entry_created` webhook

- [x] Emitted once per persisted project-scoped entry
- [x] `payload.data` carries the full entry in the **same** snake_case shape as the read API (identical 13-key set — no follow-up `GET` needed), wrapped in `{event, project_id, resource_id, resource_type, timestamp, data}`

## Append-only

- [x] `POST` / `PUT` / `PATCH` / `DELETE` on `/audit-log` → `405`
- [x] `PUT` / `PATCH` / `DELETE` on `/audit-log/{id}` → `405`

## System-originated entries

- [x] `quotas:MonitorBreach` — `principal_type`/`principal_id` null, `detail.kind: quota_monitor_breach` with metric/window/limit/observed value
- [x] `guardrails:Evaluate` — `principal_type`/`principal_id` null, guardrail as resource, decision-changing evaluation only

```jsonc
{ "action": "guardrails:Evaluate", "principal_type": null, "principal_id": null,
  "resource_srn": "soat:proj_…:guardrail:guard_…", "status": 200,
  "request_id": null, "ip": null, "user_agent": null,
  "detail": { "kind": "guardrail_evaluation", "decision": "blocked", "class": "D",
              "scope": "tool", "tool": "qa-e2e-tool-plain", "run_id": "orch_run_…",
              "guardrail_id": "guard_…", "context_source": "none", "context_snapshot": {} } }
```

## Not covered

- [ ] **Global entries** (`project_id: null`, e.g. `users:CreateUser`) — [#745](https://github.com/ttoss/soat/issues/745). Re-run on 2026-07-27 with an admin credential, which removes the 07-25 blocker. The behavior does not exist: `users:CreateUser`, `api-keys:CreateApiKey` and `policies:CreatePolicy` each returned `201` and produced **zero** audit entries, and a full scan of the log's history (369 entries) contains **no** row with `project_id: null` and **no** `users:*` / `api-keys:*` / `policies:*` action. Root cause is `shouldRecord`'s `checks.length === 0` early return in `middleware/audit.ts`: those routes authorize with a direct `ctx.authUser.role !== 'admin'` comparison instead of `authUser.isAllowed`, so the instrumentation that populates `checks` never fires. Nine modules share the pattern. This is no longer a coverage gap — it is a defect, and the box stays unchecked until #745 closes.
- [ ] **Retention sweep / `AUDIT_RETENTION_DAYS`** — needs server config plus time travel.
- [ ] **`AUDIT_QUEUE_MAX_SIZE` overflow drop-and-count** — needs a load harness.

## Side observations (not audit-log defects)

1. **Installed CLI lagged `export-audit-entries`.** `@soat/cli` 0.15.13 had
   `list-audit-entries` and `get-audit-entry` but not `export-audit-entries`,
   while the server exposed `/api/v1/audit-log/export`. `main` (0.16.1) generates
   it — release lag in the eval environment, not a code gap.
2. **A project-scoped API key can create a project it cannot then access.**
   `create-project` succeeded with a key scoped to another project; every
   subsequent call against the new project failed `403 API_KEY_PROJECT_SCOPE`.
   The key can create an orphan it has no path to use or clean up. Belongs to
   api-keys/projects, not audit-log.
