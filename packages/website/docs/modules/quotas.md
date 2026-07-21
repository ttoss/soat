---
description: "Hard, fail-closed enforcement of request rates and token/cost budgets per project, API key, or agent in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quotas

Project-scoped caps that block traffic once an aggregate limit is exceeded.

## Overview

A quota compares a windowed aggregate to a limit and blocks with `429 QUOTA_EXCEEDED` when it is breached. Quotas are cost control, not authorization: [Usage metering](./usage.md) answers "what did this cost?" and [Guardrails](./guardrails.md) answer "may this one tool call execute?", while a quota answers "has this scope exceeded its aggregate cap?".

The `requests` metric is enforced by a Koa middleware mounted after authentication: it counts **API-key-authenticated requests only** and blocks the request that pushes the counter past the limit. JWT-user (interactive) requests are never counted or blocked. The `tokens` and `cost_usd` metrics are enforced at the pre-generation check — before an agent generation starts, the current window's usage is aggregated from the [usage meter](./usage.md) and compared to the limit.

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
| `mode`          | string  | `enforce` (block with `429`) \| `monitor` (pass-through no-op until the webhook phase) |
| `current_usage` | object  | Current fixed-window usage for `requests` (`window_key`, `count`, `resets_at`); `null` for token/cost quotas (they aggregate the meter at check time) and in list responses |
| `created_at`    | string  | ISO 8601 creation timestamp                                                       |
| `updated_at`    | string  | ISO 8601 last-updated timestamp                                                   |

A quota is uniquely identified by `(project_id, scope, scope_ref, metric, window)`; creating a duplicate returns `409 QUOTA_CONFLICT`. `scope_ref` is validated to reference an api key / agent in the same project at create time. It is a soft reference: when the referenced entity is later deleted the quota goes inert (it is not cascade-deleted) and remains visible and deletable through the API.

## Key Concepts

### Scope × metric validity

Two scope/metric combinations are rejected with `400` because no attribution exists to enforce them:

- `scope: agent` with `metric: requests` — an agent's activity is not inbound HTTP traffic, and there is no precise per-request agent attribution.
- `scope: api_key` with `metric: tokens` / `cost_usd` — usage events carry no API-key attribution, so the meter cannot be aggregated per key.

So `agent` scope is valid for `tokens` / `cost_usd`, and `api_key` scope is valid for `requests`. A precise semantic for the rejected combinations can be added later without breaking the contract.

### Token and cost enforcement

`tokens` and `cost_usd` quotas are checked **before a generation starts**. The current window's usage is aggregated directly from the [usage meter](./usage.md) — a `cost_usd` quota sums the priced event cost, a `tokens` quota sums the billable token components (uncached input + output + cached; the non-billable `reasoning_tokens` detail is excluded). If the aggregate is at or over the limit, the new generation is blocked with `429 QUOTA_EXCEEDED` and nothing is metered for it.

A generation already **in flight is never killed** — its tokens are already spent and will be billed — so a budget may overshoot by at most one generation. A `project`-scoped quota aggregates the whole project; an `agent`-scoped quota with a `scope_ref` aggregates only that agent. Because the check reads the meter rather than a separate counter, quotas and usage can never disagree.

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

### quota.exceeded webhook

Every breach fires a `quota.exceeded` webhook event **once per window**, for both `enforce` and `monitor` quotas. Because a quota's window always has a discrete fixed key and usage only grows within it, the fire state is a single stored key — a breach re-fires only after the window rolls to a new key (no hysteresis). The event `data` carries `quota_id`, `project_id`, `scope`, `scope_ref`, `metric`, `window`, `window_key`, `limit`, `observed_value`, and `mode`. Subscribe a [webhook](./webhooks.md) to `quota.exceeded` (or a wildcard) to receive it.

### Monitor mode

`mode: monitor` observes without blocking: a breach fires the `quota.exceeded` webhook and lets the request (or generation) through. Use it to dry-run a cap before enforcing — flip `mode` to `enforce` via `PATCH` and the next breaching request is blocked. `enforce` quotas fire the same webhook in addition to returning `429`. (A durable audit record of monitor breaches is owned by the forthcoming audit-log module; today the webhook is the signal.)

### Formation resource

Quotas can be declared as a `quota` formation resource (`QuotaResourceProperties`): `scope`, `scope_ref`, `metric`, `window`, `limit`, `mode`. `scope`, `metric`, and `window` are immutable after creation — only `limit` and `mode` update through the formation lifecycle. Unknown fields are rejected with `400`.

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
