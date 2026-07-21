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

The API is read-only. Writes happen internally through a fire-and-forget queue, so auditing never blocks or fails the request it describes. Read auditing (logging `GET`s) is intentionally out of scope.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field                | Type    | Description                                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `id`                 | string  | Public identifier (e.g. `audit_…`)                                                                |
| `project_id`         | string  | Owning project; `null` for global actions (e.g. `users:CreateUser`)                               |
| `actor_type`         | string  | `user` or `api_key`                                                                               |
| `actor_id`           | string  | Public id of the principal (`user_…` or `key_…`)                                                  |
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

### Append-only & retention

Entries are never updated or deleted through the API; the model layer rejects updates and single-row deletes. A daily sweep prunes rows older than the retention window (see [Configuration](#configuration)). To export before expiry, paginate the list endpoint into NDJSON.

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
