---
description: "Append-only record of who did what to the SOAT platform — one entry per mutating administrative or resource action."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Audit Log

Append-only record of who did what to the platform, one entry per mutating administrative or resource action.

## Overview

The audit log answers *"who changed this policy, who deleted that secret, who rotated a webhook secret, who created an API key"*. Every mutating (`POST`/`PUT`/`PATCH`/`DELETE`) request under `/api/v1` that performs an authorization check is recorded once, post-commit, attributed to the principal (a [user](./users.md) or an [API key](./api-keys.md)) that made it. Denied attempts (`403`) are logged too — they are the highest-signal entries in a forensic review.

The log reuses the permission registry as its vocabulary: the recorded `action` **is** the permission-action string that authorized the request (e.g. `secrets:DeleteSecret`), and `resource_srn` is the SRN it was authorized against. It is distinct from [Traces](./traces.md), which record what an agent did *inside a run*; the audit log records what a principal did *to the platform*.

The API is read-only. Writes happen internally through a fire-and-forget queue, so auditing never blocks or fails the request it describes. Reads (`GET`s) are not recorded unless the project opts in — see [Read auditing](#read-auditing).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field                | Type    | Description                                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `id`                 | string  | Public identifier (e.g. `audit_…`)                                                                |
| `project_id`         | string  | Owning project; `null` for global actions (e.g. `users:CreateUser`)                               |
| `principal_type`     | string  | `user` or `api_key`; `null` for platform-originated entries (see [System-originated entries](#system-originated-entries)) |
| `principal_id`       | string  | Public id of the principal (`user_…` or `key_…`); `null` for platform-originated entries |
| `action`             | string  | The permission-action string that authorized the request                                         |
| `resource_srn`       | string  | SRN the action targeted; type-level (`soat:{project}:{type}:*`) on creates                        |
| `resource_public_id` | string  | Target resource id — from the SRN, or the response body `id` on creates                           |
| `status`             | integer | HTTP status of the response (recorded post-commit)                                                |
| `request_id`         | string  | Per-request correlation id (also returned in the `X-Request-Id` response header)                  |
| `ip`                 | string  | Client IP                                                                                         |
| `user_agent`         | string  | Request `User-Agent`                                                                              |
| `detail`             | object  | Kind-specific payload; see [Multiple checks per request](#multiple-checks-per-request)            |
| `created_at`         | string  | ISO 8601 creation timestamp (rows are immutable — there is no `updated_at`)                        |

## Key Concepts

### Request correlation (`X-Request-Id`)

Every response carries an `X-Request-Id` header, and the matching entry stores the same value in `request_id`. A caller-supplied `X-Request-Id` is honored so a correlation id can be threaded across services; otherwise one is generated per request.

### Resource SRN precision

On operations against an existing resource (`get`/`update`/`delete`), `resource_srn` is the precise SRN (`soat:{project}:secret:sec_…`) and `resource_public_id` is its last segment. Creates authorize *before* the resource exists, so `resource_srn` is type-level (`soat:{project}:secret:*`) and `resource_public_id` is captured from the response body `id`.

### Multiple checks per request

Some routes make several authorization checks (e.g. binding a trigger to a target checks both `triggers:CreateTrigger` and the target's start permission). Such a request still produces exactly **one** entry:

- On success, the primary `action` is the first (route-level) check.
- On a `403`, the primary is the denied check — labeling the entry with an earlier allowed action would misattribute the denial.

The remaining checks are recorded under `detail.additional_checks` (each an `{ action, resource, allowed }` object) so no decision is lost.

### System-originated entries

Most entries describe a principal's request, but the platform also records events that no principal directly authorized. Rather than fabricate a principal, these leave `principal_type` and `principal_id` **null** and are identified by their `action`. Filter for platform-originated entries with `principal_id` null (or by the specific `action`). Producers:

- **Quota monitoring** — a [monitor-mode quota](./quotas.md#monitor-mode) breach writes an entry with `action: quotas:MonitorBreach`, the quota as its resource, and `detail.kind: quota_monitor_breach` (metric, window, limit, observed value). It is written once per window, mirroring the `quota.exceeded` webhook.
- **Guardrail evaluations** — a [guardrail evaluation](./guardrails.md#evaluation-audit-record) that **changed the call's outcome** (`route_to_approval`, `blocked`, or `tripwire`) writes an entry with `action: guardrails:Evaluate`, the guardrail as its resource, and `detail.kind: guardrail_evaluation` carrying the full evaluation record (governing version, resolved class, decision, guard outcome, context snapshot, provenance). Plain `execute` evaluations are not audited — they are high-volume operational telemetry kept solely in the guardrails' own evaluation records. A `route_to_approval` entry also carries the filed `approval_id` in its `detail`.

### Read auditing

By default the log records mutations only: reads are high-volume and low-value, and auditing every `GET` would bury the entries a forensic review actually looks for. A project opts into read auditing by setting `audit_reads_enabled` on the [project](./projects.md):

```bash
soat update-project --project-id proj_ABC --audit-reads-enabled true
```

With the flag on, a `GET` produces the same entry shape as a mutation — the permission-action that authorized it (`secrets:GetSecret`, `secrets:ListSecrets`), its SRN, and the response status.

Two boundaries follow from the flag being per-project:

- **A read that names no project is never recorded.** Unscoped list enumeration (`GET /api/v1/secrets` with no `project_id`) is not attributable to a single project, so no project's flag can opt it in. Pass `project_id` to have list reads audited.
- **The flag is read per project, not globally.** Turning it on for one project leaves reads of every other project unrecorded.

The flag is cached briefly in-process so the read path never pays a lookup; a change through the API takes effect immediately on the instance that served it, and within 30 seconds on any other instance.

### Append-only & retention

Entries are never updated or deleted through the API; the model layer rejects updates and single-row deletes. A daily sweep prunes rows older than the retention window (see [Configuration](#configuration)). To archive before expiry, use the [NDJSON export](#ndjson-export).

### NDJSON export

`GET /api/v1/audit-log/export` streams a project's entries as newline-delimited JSON — one entry object per line, oldest first, with the same fields as the read API. It exists for archival ahead of the retention window and for shipping the log into an external system (SIEM, data lake, an LGPD/GDPR subject-access request).

- `project_id` is **required**: the export is per-project by design, not an unbounded cross-project dump.
- Every list filter (`action`, `principal_id`, `resource_public_id`, `resource_srn`, `from`, `to`) applies identically.
- The response streams and pages internally, so exporting a large project holds neither the server nor the client at full size in memory.
- It is authorized by its own action, `audit:ExportAuditEntries` — bulk egress is granted separately from `audit:ListAuditEntries`.

Entries arrive oldest-first so that a row written during the export is appended after the cursor rather than shifting rows the consumer already read.

### `audit.entry_created` webhook

Every persisted **project-scoped** entry emits an `audit.entry_created` [webhook](./webhooks.md) event carrying the full entry as its `data`, in the same snake_case shape the read API returns — so a subscriber never needs a follow-up `GET`. Subscribe with `audit.*` or the exact event name:

```bash
soat create-webhook --project-id proj_ABC \
  --url https://siem.example.com/soat --events "audit.entry_created"
```

Global entries (those with `project_id` null, e.g. `users:CreateUser`) emit nothing: webhooks are project-scoped, so such an entry has no possible subscriber. Platform-originated entries do emit, with `principal_type` and `principal_id` null.

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

### Get a single entry

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-audit-entry --entry-id audit_01HXYZ
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.audit.getAuditEntry({
  path: { entry_id: 'audit_01HXYZ' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET https://api.example.com/api/v1/audit-log/audit_01HXYZ \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
