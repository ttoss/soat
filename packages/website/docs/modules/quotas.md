---
description: "Hard, fail-closed enforcement of request rates and token/cost budgets per project, API key, or agent in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quotas

Project-scoped caps that block traffic once an aggregate limit is exceeded.

## Overview

A quota compares a windowed aggregate to a limit and blocks with `429 QUOTA_EXCEEDED` when it is breached. Quotas are cost control, not authorization: [Usage metering](./usage.md) answers "what did this cost?" and [Guardrails](./guardrails.md) answer "may this one tool call execute?", while a quota answers "has this scope exceeded its aggregate cap?".

Phase 1 enforces the `requests` metric: a Koa middleware mounted after authentication counts **API-key-authenticated requests only** and blocks the request that pushes the counter past the limit. JWT-user (interactive) requests are never counted or blocked. Token and cost budgets are enforced at the metering choke point in a later phase.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field           | Type    | Description                                                                       |
| --------------- | ------- | --------------------------------------------------------------------------------- |
| `id`            | string  | Public identifier (e.g. `quota_…`)                                                |
| `project_id`    | string  | ID of the owning project                                                          |
| `scope`         | string  | `project` \| `api_key` \| `agent`                                                 |
| `scope_ref`     | string  | Public id of the api key / agent; `null` = all entities of that scope type        |
| `metric`        | string  | `requests` \| `tokens` \| `cost_usd`                                              |
| `window`        | string  | `rolling_1m` \| `rolling_1h` \| `rolling_24h` \| `calendar_month`                 |
| `limit`         | number  | The cap (> 0)                                                                      |
| `mode`          | string  | `enforce` (block with `429`) \| `monitor` (pass-through no-op in Phase 1)          |
| `current_usage` | object  | Current fixed-window usage for `requests` (`window_key`, `count`, `resets_at`); `null` for token/cost quotas and in list responses |
| `created_at`    | string  | ISO 8601 creation timestamp                                                       |
| `updated_at`    | string  | ISO 8601 last-updated timestamp                                                   |

A quota is uniquely identified by `(project_id, scope, scope_ref, metric, window)`; creating a duplicate returns `409 QUOTA_CONFLICT`. `scope_ref` is validated to reference an api key / agent in the same project at create time. It is a soft reference: when the referenced entity is later deleted the quota goes inert (it is not cascade-deleted) and remains visible and deletable through the API.

## Key Concepts

### Scope × metric validity

`scope: agent` combined with `metric: requests` is rejected with `400` — an agent's activity is not inbound HTTP traffic and there is no precise per-request agent attribution. `agent` scope is valid for `tokens` / `cost_usd`.

### Windows and counters

For the `requests` metric, rolling windows are implemented as fixed windows keyed by the truncated timestamp (`2026-07-07T12:31Z` for `rolling_1m`); `calendar_month` keys are `YYYY-MM`. Each `(quota, window)` is one row incremented with a single atomic `UPDATE … RETURNING`, so counters are correct across server replicas with no coordination. Every request that reaches the middleware increments the counter, including requests that are subsequently rejected.

### Precedence

When multiple quotas match a request (e.g. a project-wide cap and an API-key cap), **every** `enforce` quota is checked and any breach blocks (fail closed). The most specific scope (`agent` > `api_key` > `project`) is the one reported in the error body for attribution; a more specific quota never loosens a broader one.

### Breach contract

A breach returns HTTP `429` with a `Retry-After` header (seconds until the window resets) and the standard error body:

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

### Monitor mode

`mode: monitor` is accepted and stored but is a pass-through no-op in Phase 1 — a monitor quota neither counts nor blocks. The `quota.exceeded` webhook and audit entries land in a later phase with no schema migration; monitor quotas created earlier simply start reporting when that ships.

### Self-modification footgun

Quota mutations are ordinary IAM actions with no special-case rule. Do **not** grant `quotas:UpdateQuota` / `quotas:DeleteQuota` to an autonomous API-key principal whose spend the quota is meant to cap — an admin JWT (never blocked by request quotas) can always raise or remove a quota.

## Examples

### Create a quota

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-quota --project-id proj_ABC --scope api_key --scope-ref key_ABC \
  --metric requests --window rolling_1m --limit 600
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.quotas.createQuota({
  body: {
    project_id: 'proj_ABC',
    scope: 'api_key',
    scope_ref: 'key_ABC',
    metric: 'requests',
    window: 'rolling_1m',
    limit: 600,
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/quotas \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"project_id":"proj_ABC","scope":"api_key","scope_ref":"key_ABC","metric":"requests","window":"rolling_1m","limit":600}'
```

</TabItem>
</Tabs>

### Get a quota with current usage

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-quota --quota-id quota_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.quotas.getQuota({
  path: { quota_id: 'quota_ABC' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/quotas/quota_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
