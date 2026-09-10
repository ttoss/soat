---
description: "Hard, fail-closed enforcement of request rates, token/cost budgets and the stored corpus per project, API key, agent, or end user in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quotas

Project-scoped caps that block traffic once an aggregate limit is exceeded.

## Overview

A quota compares an aggregate to a limit and blocks when it is breached: cost control, not authorization. [Usage metering](./usage.md) answers "what did this cost?", [Guardrails](./guardrails.md) "may this one tool call execute?", a quota "has this scope exceeded its cap?".

Three metrics measure a **flow** (accumulates inside a window, empties when it rolls) and breach with `429 QUOTA_EXCEEDED`. `storage_bytes` measures a **stock** (what the project holds right now) and breaches with `409 QUOTA_STORAGE_EXCEEDED` (see [Storage enforcement](#storage-enforcement)).

| Metric | Enforced |
| --- | --- |
| `requests` | Koa middleware after authentication; counts **API-key-authenticated requests only** and blocks the request that pushes the counter past the limit. JWT-user (interactive) requests are never counted or blocked, which removes the admin-lockout hazard |
| `tokens`, `cost_usd` | Pre-generation check: the current window's usage is aggregated from the [usage meter](./usage.md) and compared to the limit |
| `storage_bytes` | The corpus write paths |

### Which project a request counts against

A `requests` quota is always project-scoped (see [Scope × metric validity](#scope--metric-validity)), so every counted request needs exactly one project:

| Key | Project attributed | When |
|---|---|---|
| Project-scoped | The key's bound project | Before routing — no handler work is spent on a request the quota rejects |
| Unscoped (no bound project) | The project the route resolved **and authorized** | At the route's own permission check, before it writes anything |

Unscoped attribution waits for authorization so a caller cannot burn an unrelated project's quota by naming its public id; a denied request increments nothing. One request counts once, however many permission checks the handler makes.

- **Background drives are exempt.** Self-calls a durable run or a workflow-dispatched agent makes with a [run-as token](./orchestrations.md#durable-background-execution) are not counted, even though the token names the starting API key; they continue a request already counted on arrival.
- **Residual exemption.** A request resolving to *no single* project is not counted: an unscoped key listing across every project it can reach (no `project_id` filter, several projects accessible, or an unscoped admin key with no attached policies). Pass a `project_id`, bind the key to a project, or use `tokens`/`cost_usd` quotas, which aggregate from the usage meter.
- **Capping one specific unscoped key** is not possible: an `api_key`-scope `scope_ref` must name a key in the quota's project. Use a null-`scope_ref` `api_key` quota (or a `project` quota).

Counting scope mirrors [API-request metering](./usage.md#api-request-metering) exactly.

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
| `metric`        | string  | `requests` \| `tokens` \| `cost_usd` \| `storage_bytes`                            |
| `window`        | string  | `rolling_1m` \| `rolling_1h` \| `rolling_24h` \| `calendar_month` \| `current` (`storage_bytes` only — see [Storage enforcement](#storage-enforcement)) |
| `limit`         | number  | The cap (> 0); bytes for `storage_bytes`                                           |
| `mode`          | string  | `enforce` (block with `429`, or `409` for `storage_bytes`) \| `monitor` (observe and report, never block — see [Monitor mode](#monitor-mode)) |
| `meter_type`    | string  | The meter a `cost_usd` cap answers for (see [Meter scope](#meter-scope)); `null` = every priced meter |
| `on_unpriced`   | string  | `block` \| `allow` — what an `enforce` `cost_usd` quota does over a pricing blackout (see [Unpriced usage](#unpriced-usage)). Defaults to `block`; `null` for metrics with no pricing dependency |
| `current_usage` | object  | Current fixed-window usage for `requests` (`window_key`, `count`, `resets_at`); `null` for token/cost quotas (they aggregate the meter at check time), `null` for `storage_bytes` (a stored total has no window and no counter — read the footprint from the [storage meter](./usage.md#storage-metering)), and `null` in list responses |
| `created_at`    | string  | ISO 8601 creation timestamp                                                       |
| `updated_at`    | string  | ISO 8601 last-updated timestamp                                                   |

Identity is `(project_id, scope, scope_ref, metric, window, meter_type)`; a duplicate returns `409 QUOTA_CONFLICT`. `scope_ref` must reference an api key / agent / actor in the same project at create time; it is a soft reference: when the entity is deleted the quota goes inert (not cascade-deleted), still visible and deletable.

## Key Concepts

### Scope × metric validity

A quota is accepted only for a scope the metric can be aggregated by; anything else is `400`, never a silent no-op.

| Metric | Valid scopes |
| --- | --- |
| `requests` | `project`, `api_key` |
| `tokens` | `project`, `agent`, `actor` |
| `cost_usd` | `project`, `agent`, `actor` |
| `storage_bytes` | `project` |

Each metric is scoped by what measures it: the request middleware sees API key and project, not agent or end user; the [usage meter](./usage.md) carries project, agent and end user, not API key; the [storage snapshot](./usage.md#storage-metering) measures a project's footprint only.

`window` is validated both ways: `storage_bytes` accepts only `current`; every other metric refuses it.

### Token and cost enforcement

`tokens` and `cost_usd` quotas are checked **before a generation starts**, aggregating the current window from the [usage meter](./usage.md): `cost_usd` sums the priced event cost, `tokens` sums the billable token components (uncached input + output + cached; the non-billable `reasoning_tokens` detail is excluded). At or over the limit, the generation is blocked with `429 QUOTA_EXCEEDED` and nothing is metered for it.

### Storage enforcement

`storage_bytes` caps what a project **holds**: [files](./files.md), document chunks (text *and* vector), memory entries and the [evaluations](./evaluations.md) corpus, all [metered](./usage.md#storage-metering). No other metric bounds them.

| | Flow metrics | `storage_bytes` |
| --- | --- | --- |
| `window` | a fixed window | `current` |
| Aggregate | events inside the window | the project's footprint |
| Breach | `429 QUOTA_EXCEEDED` | `409 QUOTA_STORAGE_EXCEEDED` |
| `Retry-After` | seconds until the window resets | not sent |
| What clears it | the window rolling | deleting stored content |
| `current_usage` | a counter (`requests`) or `null` | `null` |

As with [`QUOTA_UNENFORCEABLE`](#unpriced-usage), waiting is no remedy, so `409` and no `Retry-After`. `meta` carries `current_bytes` beside `limit`, no `resets_at`:

```json
{
  "error": {
    "code": "QUOTA_STORAGE_EXCEEDED",
    "message": "Storage quota quota_V1StGXR8Z5jdHi6B exceeded: the project stores more than its 5000000000-byte limit.",
    "meta": {
      "quota_id": "quota_V1StGXR8Z5jdHi6B",
      "metric": "storage_bytes",
      "limit": 5000000000,
      "current_bytes": 5241041920
    }
  }
}
```

#### Where the cap acts

Enforced on the caller-facing corpus writes, all creates, so a refusal leaves nothing half-written:

| Path | Delta counted |
| --- | --- |
| [`POST /api/v1/files/upload`](/docs/api/files/upload-file), [`/upload/base64`](/docs/api/files/upload-file-base-64), [`/upload/{token}`](/docs/api/files/upload-file-with-token) | the uploaded bytes |
| [`POST /api/v1/files`](/docs/api/files/create-file) | the declared `size` — metadata-only, but it is what the meter sums for the row |
| [`POST /api/v1/documents`](/docs/api/documents/create-document) | the `content` bytes |
| [`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document), [`POST /api/v1/documents/{document_id}/ingest`](/docs/api/documents/reingest-document) | none — the source file is already stored and measured; what ingestion adds is chunk text and vectors, produced after the response |
| [`POST /api/v1/memory-entries`](/docs/api/memory-entries/create-memory-entry) | the `content` bytes |
| [`POST /api/v1/datasets/{dataset_id}/items`](/docs/api/evaluations/create-dataset-item), [`/items/from-generation`](/docs/api/evaluations/create-dataset-item-from-generation) | the serialized `input`, `expected_output` and `metadata` |

The `file`, `document`, `memory_entry` and `dataset_item` [formation](./formations.md) resources are held to the same cap.

**Writes driven from inside a generation or run are exempt**, since a refusal would leave the turn or run half persisted: [conversation](./conversations.md) messages (each a `Document` with chunks and embeddings), memory entries from the `write_memory` tool, [automatic extraction](./memories.md) or an [orchestration](./orchestrations.md) `memory_write` node, and [`eval_results`](./evaluations.md) rows. The cap bounds deliberate ingest; `monitor`-mode data says whether that is enough.

#### Measured against the last snapshot

The footprint is the newest [`storage` event](./usage.md#storage-metering) plus the request's own delta, never a live scan (which joins every chunk row through documents and files). The cap accepts **up to a day of staleness**; a burst inside one day spends against a figure that has not heard of it.

- **A never-metered project is measured on its delta alone**: an upload larger than the whole cap is refused; everything smaller is admitted until the first snapshot.
- **The cap is approximate on the way up.** Chunks and vectors weigh several times the source text ([`chunk_count` and `gb_day`](./usage.md#storage-metering)) and are not in the delta. Size the cap for the footprint you will hold, not the byte the refusal fires on.

**A capped-out project is wedged** until a human removes something. Ship a cap in `monitor` mode first.

#### Recovering

Delete content ([files](./files.md), [documents](./documents.md), [memory entries](./memories.md), [dataset items](./evaluations.md)); deletes are never refused and the next snapshot clears the breach. Raising the cap with [`PATCH /api/v1/quotas/{quota_id}`](/docs/api/quotas/update-quota) or switching to `monitor` clears it immediately. A **re-ingest is refused too**: it can grow the corpus.

### Unpriced usage

Usage events carry `cost_usd: null` when no [price-book](./usage.md#pricing) row covers them and contribute `0` to a `cost_usd` aggregate (`tokens` sums component quantities, always recorded). A window that metered usage and priced **none** of it aggregates to `0` and can never fire; an `enforce` quota then follows `on_unpriced`:

- **`block`** (default): new generations are refused with `409 QUOTA_UNENFORCEABLE`.
- **`allow`**: they pass; availability over containment, recorded on the quota.

```json
{
  "error": {
    "code": "QUOTA_UNENFORCEABLE",
    "message": "Cost quota qta_... cannot be enforced: the current window metered usage but priced none of it.",
    "meta": {
      "quota_id": "qta_...",
      "metric": "cost_usd",
      "limit": 25,
      "window": "calendar_month",
      "unpriced_rows": [
        { "provider": "openai", "model": "gpt-4o", "component": "input_tokens" },
        { "provider": "openai", "model": "gpt-4o", "component": "output_tokens" }
      ]
    }
  }
}
```

Verdict rules:

- A **blackout** is at least 3 metered events in the window, none priced. One or two all-unpriced events pass (the exception below still files), so a fresh window's first event landing on one unpriced model does not stop a mostly-priced project at every boundary.
- A **partly** priced window never refuses (that would block the generation that lands the first priced event, making the cap unrecoverable) but is always **reported**: a priced model A beside an unpriced model B reads A's spend alone, so a `$100` cap passes while `$530` is spent.
- `unpriced_rows` lists the distinct `(provider, model, component)` the window metered and no price row covered, capped at 10, so no trip through the [rollup](./usage.md#aggregation) is needed. Zero-quantity components and non-billable details are left out. Rows are per **component**, not per event, which exposes a **partly priced event**: a model priced for input but not output tokens carries a real `cost_usd` that understates itself; `output_tokens` in `unpriced_rows` shows it.
- The verdict reads the [`llm_tokens`](./usage.md#meter-types-and-components) meter alone, while the guarded aggregate sums **every** priced meter the [meter scope](#meter-scope) admits. Platform meters such as `compute_execution` are priced by the operator from a `soat` SKU; counting them would let unpriced platform events refuse the first priced AI generation, or a priced platform event mask a genuine AI blackout. A quota naming a **platform** meter therefore has no verdict: never a blackout, never the exception below. An `llm_tokens`-scoped quota is held to the verdict.
- [Embeddings](./embeddings.md#pricing-embeddings) are held out of the verdict: their rate is deployment configuration outside every price book tier, so counting them unpriced would refuse a cap no one in the project can satisfy, and counting them priced (an unset rate meters at `0`) would report the window measurable. Embedding spend still counts towards the aggregate and never appears in `unpriced_rows`.
- **No `Retry-After`, and no `quota.exceeded` webhook**: no limit was reached. Configure the [price book](./usage.md#pricing) for the models in use, or set `on_unpriced` to `allow`.
- **`monitor` mode never blocks**, whatever `on_unpriced` says; it gets the exception below and nothing else.
- `on_unpriced` is storable on `cost_usd` quotas only; elsewhere the write is `400`.

Whatever the posture, a `cost_usd` check that finds AI usage no price row covered files a `quota_unpriced` [exception](./exceptions.md) (severity `warning`) carrying the quota, its limit, the window's `llm_tokens` event count, how many were unpriced, and the same `unpriced_rows`, from the **first** unpriced row, so the triage item precedes any refusal. Blackout and partly-priced windows file the **same** item, deduped on the quota; `occurrence_count` is the number of generations that ran under it. An empty window files and refuses nothing.

A generation **in flight is never killed**, so a budget may overshoot by at most one generation. A `project` quota aggregates the whole project; an `agent` quota with a `scope_ref` only that agent; an `actor` quota only the end user behind the generation (see [Actor scope](#actor-scope)). The check reads the meter, not a separate counter, so quotas and usage never disagree.

### Meter scope

A `cost_usd` quota sums every priced meter by default, so a newly priced platform meter would consume a cap set to bound *model* spend. `meter_type` names the meter a cap answers for:

```json
{
  "scope": "project",
  "metric": "cost_usd",
  "window": "calendar_month",
  "limit": 200,
  "meter_type": "llm_tokens"
}
```

- **Omitted** (`null`): every priced meter counts.
- **Named**, one of [`llm_tokens`, `compute_execution`, `api_request`, `storage`](./usage.md#meter-types-and-components): that meter alone. Any other value is `400` (it would aggregate `0` forever).
- Only `cost_usd` takes it; on any other metric the write is `400`.

`meter_type` is part of the quota's **identity**: an AI cap, a storage cap and an unscoped cap over the same scope and window are three distinct budgets. Immutable; replace the quota to change it.

### Actor scope

An `actor` quota caps one **end user** ([Actors](./actors.md)) regardless of agent: *"no single user costs me more than $5/month"*.

The end user is derived from the generation's [session](./sessions.md), never a separate argument, as in [usage attribution](./usage.md#end-user-attribution), so the actor enforced against is the actor billed. A generation with **no session** (a direct API call, a [trigger](./triggers.md), an [orchestration](./orchestrations.md) node) or a session without `actor_id` matches no actor quota; cap that traffic with a `project` or `agent` quota.

#### `scope_ref: null` means one budget per actor

For `actor` scope a null `scope_ref` is **one budget per actor**, not a pooled total: *"every end user gets 100k tokens a month"*, and one user exhausting theirs blocks nobody else:

```bash
soat create-quota --project-id proj_ABC --scope actor \
  --metric tokens --window calendar_month --limit 100000
```

Set a `scope_ref` to cap one named actor instead (a larger allowance, or throttling an abusive user).

:::note
This differs from `agent` scope, where a null `scope_ref` aggregates the whole project — a pooled all-actors total would duplicate a `project` quota.
:::

#### Webhook granularity

The `quota.exceeded` webhook fires **once per window per quota**, not per actor: the first actor to breach fires it, later ones in that window are silent. Every actor is still blocked independently. To see who hit their cap, query the meter with `group_by=actor` (see [Usage](./usage.md)).

### Windows and counters

For `requests`, rolling windows are fixed windows keyed by the truncated timestamp (`2026-07-07T12:31Z` for `rolling_1m`); `calendar_month` keys are `YYYY-MM`. Each `(quota, window)` is one row incremented with one atomic `UPDATE … RETURNING`, so counters are correct across replicas. Every request reaching the middleware increments it, including requests subsequently rejected.

- **Within a window the limit is exact at any concurrency**: increment and comparison are one statement.
- **Across a boundary the count resets, not decays**: a `rolling_1m` cap of 60 admits 60 requests at `12:00:59` and 60 more at `12:01:00`. Size the window for the burst you will absorb, or use a longer window with a proportionally larger limit.

### Precedence

When several quotas match, **every** `enforce` quota is checked and any breach blocks (fail closed). The most specific scope (`actor` > `agent` > `api_key` > `project`) is reported in the error body; a more specific quota never loosens a broader one.

### Breach contract

A **flow** breach returns HTTP `429` with a `Retry-After` header (seconds until the window resets) and the standard error body; a `storage_bytes` breach returns `409` with no `Retry-After` (see [Storage enforcement](#storage-enforcement)):

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

Every breach fires `quota.exceeded` **once per window**, for `enforce` and `monitor` quotas alike; the fire state is one stored window key, re-fired only when the window rolls (no hysteresis). `data` carries `quota_id`, `project_id`, `scope`, `scope_ref`, `metric`, `meter_type`, `window`, `window_key`, `limit`, `observed_value`, and `mode`, so a consumer can tell which [meter](#meter-scope) breached without a fetch. Subscribe a [webhook](./webhooks.md) to `quota.exceeded` (or a wildcard).

A `storage_bytes` quota's `window_key` is the **snapshot's own UTC day**: one report per fresh measurement while a project stays over cap.

### Monitor mode

`mode: monitor` observes without blocking: a breach fires `quota.exceeded` and lets the request, generation or corpus write through. Dry-run a cap, then flip `mode` to `enforce` via `PATCH`; the next breaching request is blocked. `enforce` quotas fire the same webhook beside the `429`.

A monitor breach leaves no trace on the request, so it also writes an [audit-log](./audit-log.md) entry once per window: `action: quotas:MonitorBreach` (`principal_type`/`principal_id` null), the quota as resource, `detail.kind` `quota_monitor_breach` with metric, meter scope, window, limit and observed value. `enforce` breaches need none: the audit log records the `429`.

### Formation resource

A `quota` formation resource (`QuotaResourceProperties`) takes `scope`, `scope_ref`, `metric`, `window`, `limit`, `mode`, `on_unpriced`, `meter_type`, validated by the same function as the REST route. `scope_ref` may be a `{ "ref": … }` to an actor resource in the same template. Only `limit` and `mode` update through the lifecycle. Unknown fields are `400`.

`scope`, `scope_ref`, `metric`, `window`, and `meter_type` are immutable (they key the window counters). Declaring a **different** value fails the operation: the formation is left `status: "failed"` with the field named in the operation error, and the quota keeps every previous value (`limit` and `mode` are never applied piecemeal). Restating a current value is fine; `scope`, `metric`, and `window` are required on create, so templates carry them on every update. To change one, replace the resource.

Omitting the nullable `scope_ref` means "not supplied", not clearing it; an explicit `null` disagreeing with the stored ref is a change. For `actor` scope, `null` is [one budget per actor](#scope_ref-null-means-one-budget-per-actor), a ref one named actor.

### Self-modification footgun

Quota mutations are ordinary IAM actions. Do **not** grant `quotas:UpdateQuota` / `quotas:DeleteQuota` to an autonomous API-key principal whose spend the quota caps. An admin JWT (never blocked by request quotas) can always raise or remove a quota.

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

### Cap the stored corpus

In `monitor` mode first: it reports which projects would breach and refuses nothing.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-quota --project-id proj_ABC --scope project \
  --metric storage_bytes --window current --limit 5000000000 --mode monitor
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.quotas.createQuota({
  body: {
    project_id: 'proj_ABC',
    scope: 'project',
    metric: 'storage_bytes',
    window: 'current',
    limit: 5_000_000_000,
    mode: 'monitor',
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
  -d '{"project_id":"proj_ABC","scope":"project","metric":"storage_bytes","window":"current","limit":5000000000,"mode":"monitor"}'
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
