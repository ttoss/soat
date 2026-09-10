---
description: "Append-only record of who did what to the SOAT platform — one entry per mutating administrative or resource action."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Audit Log

Append-only record of who did what to the platform, one entry per mutating administrative or resource action.

## Overview

Every mutating (`POST`/`PUT`/`PATCH`/`DELETE`) request under `/api/v1` that performs an authorization check is recorded once, post-commit, attributed to the principal (a [user](./users.md) or [API key](./api-keys.md)). Denied attempts (`403`) are logged too.

The recorded `action` **is** the permission-action string that authorized the request (e.g. `secrets:DeleteSecret`); `resource_srn` is the SRN it was authorized against. [Traces](./traces.md) record what an agent did *inside a run*; the [Activity](./activity.md) feed records what agents did autonomously with no principal; the audit log records what a principal did *to the platform*. Comparison: [Activity vs. the audit log vs. traces](./activity.md#activity-vs-the-audit-log-vs-traces).

The API is read-only; writes go through a fire-and-forget queue, so auditing never blocks or fails the request. Reads are recorded only when the project opts in; see [Read auditing](#read-auditing).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Gate a Dangerous Tool with Guardrails - Step 11 (Read the governance trail)](/docs/tutorials/gate-a-tool-with-guardrails#step-11--read-the-governance-trail)
- [Cap Spend Per End User - Step 11 (Observe before you enforce)](/docs/tutorials/cap-spend-per-end-user#step-11--observe-before-you-enforce)

## Data Model

| Field                | Type    | Description                                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `id`                 | string  | Public identifier (e.g. `audit_…`)                                                                |
| `project_id`         | string  | Owning project; `null` for global actions (e.g. `users:CreateUser`)                               |
| `principal_type`     | string  | `user` or `api_key`; `null` for platform-originated entries (see [System-originated entries](#system-originated-entries)) |
| `principal_id`       | string  | Public id of the principal (`user_…` or `key_…`); `null` for platform-originated entries |
| `action`             | string  | The permission-action string that authorized the request                                         |
| `resource_srn`       | string  | SRN the action targeted; type-level (`srn:{project}:{type}:*`) on creates                        |
| `resource_public_id` | string  | Target resource id — from the SRN, or the response body `id` on creates                           |
| `status`             | integer | HTTP status of the response (recorded post-commit)                                                |
| `request_id`         | string  | Per-request correlation id (also returned in the `X-Request-Id` response header)                  |
| `ip`                 | string  | Client IP                                                                                         |
| `user_agent`         | string  | Request `User-Agent`                                                                              |
| `detail`             | object  | Kind-specific payload; see [Multiple checks per request](#multiple-checks-per-request)            |
| `created_at`         | string  | ISO 8601 creation timestamp (rows are immutable — there is no `updated_at`)                        |

## Key Concepts

### Request correlation (`X-Request-Id`)

Every response carries `X-Request-Id`, stored as `request_id`. A caller-supplied value is honored; otherwise one is generated.

### Resource SRN precision

On `get`/`update`/`delete`, `resource_srn` is precise (`srn:{project}:secret:sec_…`) and `resource_public_id` its last segment. Creates authorize *before* the resource exists, so `resource_srn` is type-level (`srn:{project}:secret:*`) and `resource_public_id` comes from the response body `id`.

### Multiple checks per request

A route making several checks (e.g. binding a trigger checks `triggers:CreateTrigger` and the target's start permission) produces exactly **one** entry:

- On success, the primary `action` is the first (route-level) check.
- On a `403`, the primary is the denied check.

Remaining checks are recorded under `detail.additional_checks` (`{ action, resource, allowed }` each).

### System-originated entries

Events no principal authorized leave `principal_type` and `principal_id` **null** and are identified by `action`. There is no null-principal filter; filter by `action` (`quotas:MonitorBreach`, `guardrails:Evaluate`). Producers:

- **Quota monitoring** — a [monitor-mode quota](./quotas.md#monitor-mode) breach writes `action: quotas:MonitorBreach`, the quota as resource, `detail.kind: quota_monitor_breach` (metric, window, limit, observed value); once per window, mirroring the `quota.exceeded` webhook.
- **Guardrail evaluations** — an [evaluation](./guardrails.md#evaluation-audit-record) that **changed the outcome** (`route_to_approval`, `blocked`, `tripwire`) writes `action: guardrails:Evaluate`, the guardrail as resource, `detail.kind: guardrail_evaluation` with the full record (governing version, resolved class, decision, guard outcome, context snapshot, provenance). Plain `execute` evaluations are not audited; they stay in the guardrails' own evaluation records. A `route_to_approval` entry also carries `approval_id` in `detail`.

### Read auditing

By default only mutations are recorded. A project opts into read auditing with `audit_reads_enabled` on the [project](./projects.md):

```bash
soat update-project --project-id proj_ABC --audit-reads-enabled true
```

A `GET` then produces the same entry shape: the authorizing action (`secrets:GetSecret`, `secrets:ListSecrets`), its SRN, and the status. The flag is per-project:

- **A read naming no project is never recorded.** Unscoped enumeration ([`GET /api/v1/secrets`](/docs/api/secrets/list-secrets) without `project_id`) is not attributable to a project; pass `project_id` to have list reads audited.
- Turning it on for one project leaves other projects' reads unrecorded.

The flag is cached in-process: a change applies immediately on the serving instance and within 30 seconds elsewhere.

### Append-only & retention

Entries are never updated or deleted through the API; the model layer rejects updates and single-row deletes. A daily sweep (also run at startup) prunes rows older than the retention window (see [Configuration](#configuration)). Archive before expiry with the [NDJSON export](#ndjson-export).

### NDJSON export

[`GET /api/v1/audit-log/export`](/docs/api/audit-log/export-audit-entries) streams a project's entries as newline-delimited JSON, oldest first, same fields as the read API, for archival and shipping to a SIEM, data lake, or an LGPD/GDPR subject-access request.

- `project_id` is **required**.
- Every list filter (`action`, `principal_id`, `resource_public_id`, `resource_srn`, `from`, `to`) applies identically.
- The response streams and pages internally.
- Authorized by `audit:ExportAuditEntries`, separate from `audit:ListAuditEntries`.

The export is not an MCP or `builtin` tool action (unbounded stream); tools use the paged `list-audit-entries` with the same filters.

### `audit.entry_created` webhook

Every persisted **project-scoped** entry emits an `audit.entry_created` [webhook](./webhooks.md) event with the full entry as `data`, in the read API's snake_case shape. Subscribe with `audit.*` or the exact name:

```bash
soat create-webhook --project-id proj_ABC \
  --url https://siem.example.com/soat --events "audit.entry_created"
```

Global entries (`project_id` null, e.g. `users:CreateUser`) emit nothing; platform-originated entries do, with null principal fields.

## Configuration

| Environment Variable            | Required | Description                                                                 |
| ------------------------------- | -------- | --------------------------------------------------------------------------- |
| `AUDIT_RETENTION_DAYS`          | No       | Retention window in days (default `365`). Rows older than this are pruned.  |
| `AUDIT_QUEUE_MAX_SIZE`          | No       | Max entries buffered in memory (default `1000`). On overflow entries are dropped and counted. |
| `AUDIT_RETENTION_SWEEP_DISABLED`| No       | Set to `true` to disable the daily retention sweep.                         |

## Examples

### List audit entries

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-audit-entries --project-id proj_ABC --action secrets:DeleteSecret
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.audit.listAuditEntries({
  query: { project_id: 'proj_ABC', action: 'secrets:DeleteSecret' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET "https://api.example.com/api/v1/audit-log?project_id=proj_ABC&action=secrets:DeleteSecret" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Export a project's entries as NDJSON

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat export-audit-entries --project-id proj_ABC --from 2026-01-01T00:00:00Z
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.audit.exportAuditEntries({
  query: { project_id: 'proj_ABC', from: '2026-01-01T00:00:00Z' },
});
if (error) throw new Error(JSON.stringify(error));
// `data` is the raw NDJSON body — one JSON object per line.
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET "https://api.example.com/api/v1/audit-log/export?project_id=proj_ABC" \
  -H "Authorization: Bearer <token>" > audit-log.ndjson
```

</TabItem>
</Tabs>

