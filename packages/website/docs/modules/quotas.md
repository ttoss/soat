---
description: "Hard, fail-closed enforcement of request rates and token/cost budgets per project, API key, agent, or end user in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quotas

Project-scoped caps that block traffic once an aggregate limit is exceeded.

## Overview

A quota compares a windowed aggregate to a limit and blocks with `429 QUOTA_EXCEEDED` when it is breached. Quotas are cost control, not authorization: [Usage metering](./usage.md) answers "what did this cost?" and [Guardrails](./guardrails.md) answer "may this one tool call execute?", while a quota answers "has this scope exceeded its aggregate cap?".

The `requests` metric is enforced by a Koa middleware mounted after authentication: it counts **API-key-authenticated requests only** and blocks the request that pushes the counter past the limit. JWT-user (interactive) requests are never counted or blocked. The `tokens` and `cost_usd` metrics are enforced at the pre-generation check — before an agent generation starts, the current window's usage is aggregated from the [usage meter](./usage.md) and compared to the limit.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Cap Spend Per End User - Step 7 (One quota, one budget per end user)](/docs/tutorials/cap-spend-per-end-user#step-7--one-quota-one-budget-per-end-user)
- [Cap Spend Per End User - Step 8 (One user is blocked, the other is not)](/docs/tutorials/cap-spend-per-end-user#step-8--one-user-is-blocked-the-other-is-not)
- [Cap Spend Per End User - Step 11 (Observe before you enforce)](/docs/tutorials/cap-spend-per-end-user#step-11--observe-before-you-enforce)

## Data Model

| Field           | Type    | Description                                                                       |
| --------------- | ------- | --------------------------------------------------------------------------------- |
| `id`            | string  | Public identifier (e.g. `quota_…`)                                                |
| `project_id`    | string  | ID of the owning project                                                          |
| `scope`         | string  | `project` \| `api_key` \| `agent` \| `actor`                                      |
| `scope_ref`     | string  | Public id of the api key / agent / [actor](./actors.md); `null` = all entities of that scope type (for `actor`, one budget *per* actor — see [Actor scope](#actor-scope)) |
| `metric`        | string  | `requests` \| `tokens` \| `cost_usd`                                              |
| `window`        | string  | `rolling_1m` \| `rolling_1h` \| `rolling_24h` \| `calendar_month`                 |
| `limit`         | number  | The cap (> 0)                                                                      |
| `mode`          | string  | `enforce` (block with `429`) \| `monitor` (observe and report, never block — see [Monitor mode](#monitor-mode)) |
| `current_usage` | object  | Current fixed-window usage for `requests` (`window_key`, `count`, `resets_at`); `null` for token/cost quotas (they aggregate the meter at check time) and in list responses |
| `created_at`    | string  | ISO 8601 creation timestamp                                                       |
| `updated_at`    | string  | ISO 8601 last-updated timestamp                                                   |

A quota is uniquely identified by `(project_id, scope, scope_ref, metric, window)`; creating a duplicate returns `409 QUOTA_CONFLICT`. `scope_ref` is validated to reference an api key / agent / actor in the same project at create time. It is a soft reference: when the referenced entity is later deleted the quota goes inert (it is not cascade-deleted) and remains visible and deletable through the API.

## Key Concepts

### Scope × metric validity

A quota is only accepted for a scope the metric can actually be aggregated by. Anything outside this table is rejected with `400` rather than stored as a silent no-op — a cap that cannot be aggregated would look healthy through the API while protecting nothing.

| Metric | Valid scopes |
| --- | --- |
| `requests` | `project`, `api_key` |
| `tokens` | `project`, `agent`, `actor` |
| `cost_usd` | `project`, `agent`, `actor` |

The exclusions follow from where each metric is measured. `requests` is counted by the request middleware, which sees the API key and the project but not the agent or end user behind the call. `tokens` / `cost_usd` aggregate the [usage meter](./usage.md), which carries project, agent, and end-user attribution but no API-key attribution.

Widening this table later is backward-compatible; a precise semantic for a currently-rejected combination can be added without breaking the contract.

### Token and cost enforcement

`tokens` and `cost_usd` quotas are checked **before a generation starts**. The current window's usage is aggregated directly from the [usage meter](./usage.md) — a `cost_usd` quota sums the priced event cost, a `tokens` quota sums the billable token components (uncached input + output + cached; the non-billable `reasoning_tokens` detail is excluded). If the aggregate is at or over the limit, the new generation is blocked with `429 QUOTA_EXCEEDED` and nothing is metered for it.

A `cost_usd` quota is only as good as the project's pricing. Usage events carry `cost_usd: null` when no [price-book](./usage.md#pricing) row covers them, and an unpriced event contributes `0` to the aggregate — so on a project with no effective prices a `cost_usd` cap never breaches and never blocks. A `tokens` quota has no such dependency: it sums component quantities, which are always recorded.

Because that is the one case where a quota fails **open**, it is not left silent: when a `cost_usd` check finds the window held metered usage but nothing priced, a `quota_unpriced` [exception](./exceptions.md) is filed (severity `warning`) carrying the quota, its limit, and the unpriced event count. It is deduped on the quota, so one dead cap is one triage item and its `occurrence_count` is the number of generations that ran unprotected. Resolve it by configuring the [price book](./usage.md#pricing) — an empty window files nothing, since a zero aggregate with nothing metered is legitimately zero.

A generation already **in flight is never killed** — its tokens are already spent and will be billed — so a budget may overshoot by at most one generation. A `project`-scoped quota aggregates the whole project; an `agent`-scoped quota with a `scope_ref` aggregates only that agent; an `actor`-scoped quota aggregates only the end user behind the generation (see [Actor scope](#actor-scope)). Because the check reads the meter rather than a separate counter, quotas and usage can never disagree.

### Actor scope

An `actor` quota caps the spend of one **end user** — see [Actors](./actors.md) — rather than one agent or the whole project. It is the cap a per-user product needs: *"no single user costs me more than $5/month"*, enforced regardless of which agent they talk to.

The end user is derived from the generation's [session](./sessions.md), never accepted as a separate argument. That is the same rule [usage attribution](./usage.md#end-user-attribution) follows, so the actor a quota is enforced against is always the actor the resulting usage event is billed to — a caller cannot spend one actor's budget under another actor's session.

A generation with **no session** has no end user behind it (a direct API call, a [trigger](./triggers.md), an [orchestration](./orchestrations.md) node), so it matches no actor quota. The same applies to a session that carries no `actor_id`. Cap that traffic with a `project` or `agent` quota.

#### `scope_ref: null` means one budget per actor

For `actor` scope a null `scope_ref` is **one budget per actor**, evaluated against the current generation's actor — not a single pooled total across all actors. So one quota expresses *"every end user gets 100k tokens a month"*, and one user exhausting theirs does not block anyone else:

```bash
soat create-quota --project-id proj_ABC --scope actor \
  --metric tokens --window calendar_month --limit 100000
```

Set a `scope_ref` to cap one named actor instead — e.g. to give a specific user a larger allowance, or to throttle an abusive one.

:::note
This differs from `agent` scope, where a null `scope_ref` aggregates the whole project. The divergence is deliberate: a project-wide aggregate is already exactly what a `project` quota expresses, so reading a null-ref actor quota as "all actors pooled" would make the combination a duplicate under a misleading name. Per-actor is the only reading that cannot be spelled another way.
:::

#### Webhook granularity

The `quota.exceeded` webhook fires **once per window per quota**, not once per actor. On a null-ref actor quota that means the first actor to breach in a window fires it and later breaching actors in that same window are silent. Enforcement itself is unaffected — every actor is still checked against their own budget and blocked independently. To see exactly who hit their cap, query the meter with `group_by=actor` (see [Usage](./usage.md)).

### Windows and counters

For the `requests` metric, rolling windows are implemented as fixed windows keyed by the truncated timestamp (`2026-07-07T12:31Z` for `rolling_1m`); `calendar_month` keys are `YYYY-MM`. Each `(quota, window)` is one row incremented with a single atomic `UPDATE … RETURNING`, so counters are correct across server replicas with no coordination. Every request that reaches the middleware increments the counter, including requests that are subsequently rejected.

### Precedence

When multiple quotas match a request (e.g. a project-wide cap and an API-key cap), **every** `enforce` quota is checked and any breach blocks (fail closed). The most specific scope (`actor` > `agent` > `api_key` > `project`) is the one reported in the error body for attribution; a more specific quota never loosens a broader one. `actor` ranks highest because it names one end user — the narrowest population a cap can address, and so the most actionable thing to report to a caller who was just blocked.

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

`mode: monitor` observes without blocking: a breach fires the `quota.exceeded` webhook and lets the request (or generation) through. Use it to dry-run a cap before enforcing — flip `mode` to `enforce` via `PATCH` and the next breaching request is blocked. `enforce` quotas fire the same webhook in addition to returning `429`.

Because a monitor breach never blocks, the request it rode in on returns success and leaves no trace beyond the webhook. So a monitor breach also writes a durable [audit-log](./audit-log.md) entry — `action: quotas:MonitorBreach` (no principal authorized it, so `principal_type`/`principal_id` are null), the quota as its resource, and a `detail.kind` of `quota_monitor_breach` carrying the metric, window, limit, and observed value. Like the webhook, it is written once per window. `enforce` breaches need no such entry: they surface as the `429` the audit log already records on the blocked request.

### Formation resource

Quotas can be declared as a `quota` formation resource (`QuotaResourceProperties`): `scope`, `scope_ref`, `metric`, `window`, `limit`, `mode`. A `scope_ref` naming an actor can be a `{ "ref": … }` to an actor resource in the same template. Only `limit` and `mode` update through the formation lifecycle. Unknown fields are rejected with `400`.

`scope`, `scope_ref`, `metric`, and `window` are immutable after creation — together with the project they form the quota's identity, and its window counters are keyed to that identity. Declaring a **different** value for any of them fails the operation: the formation is left `status: "failed"` with the offending field named in the operation error, and the quota keeps every one of its previous values (including `limit` and `mode`, which are never applied piecemeal on a failed update). Restating an immutable field at its current value is always fine — templates carry `scope`, `metric`, and `window` on every update because they are required on create. To change one, replace the quota resource.

Because `scope_ref` is nullable, omitting it is treated as "not supplied" rather than as clearing it; an explicit `null` that disagrees with the stored ref is a change. For `actor` scope that difference is especially load-bearing: `null` is [one budget per actor](#scope_ref-null-means-one-budget-per-actor), while a ref caps one named actor.

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
