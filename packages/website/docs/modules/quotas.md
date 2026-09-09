---
description: "Hard, fail-closed enforcement of request rates, token/cost budgets and the stored corpus per project, API key, agent, or end user in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quotas

Project-scoped caps that block traffic once an aggregate limit is exceeded.

## Overview

A quota compares an aggregate to a limit and blocks when it is breached. Quotas are cost control, not authorization: [Usage metering](./usage.md) answers "what did this cost?" and [Guardrails](./guardrails.md) answer "may this one tool call execute?", while a quota answers "has this scope exceeded its cap?".

Three of the four metrics measure a **flow** — something that accumulates inside a window and empties when it rolls — and breach with `429 QUOTA_EXCEEDED`. The fourth measures a **stock**: `storage_bytes` caps what the project holds right now, and breaches with `409 QUOTA_STORAGE_EXCEEDED` (see [Storage enforcement](#storage-enforcement)).

The `requests` metric is enforced by a Koa middleware mounted after authentication: it counts **API-key-authenticated requests only** and blocks the request that pushes the counter past the limit. JWT-user (interactive) requests are never counted or blocked — interactive users are not the runaway surface, and exempting them removes the admin-lockout hazard. The `tokens` and `cost_usd` metrics are enforced at the pre-generation check — before an agent generation starts, the current window's usage is aggregated from the [usage meter](./usage.md) and compared to the limit. `storage_bytes` is enforced on the corpus write paths.

### Which project a request counts against

A `requests` quota is always project-scoped (see [Scope × metric validity](#scope--metric-validity)), so every counted request needs exactly one project to count against. Where that project comes from depends on the key:

| Key | Project attributed | When |
|---|---|---|
| Project-scoped | The key's bound project | Before routing — no handler work is spent on a request the quota rejects |
| Unscoped (no bound project) | The project the route resolved **and authorized** | At the route's own permission check, before it writes anything |

Attribution for an unscoped key deliberately waits for authorization. Counting a client-supplied `project_id` before checking permission would let any key holder burn an unrelated project's `requests` quota by naming its (non-secret) public id, so only a project the caller genuinely holds access to is ever counted — a denied request increments nothing.

One request counts once, no matter how many permission checks the handler makes.

**Background drives are exempt.** The platform self-calls a durable run or a workflow-dispatched agent makes with a [run-as token](./orchestrations.md#durable-background-execution) are not counted, even though the token names the API key that started the work. They are machinery continuing a request that was already counted on arrival, not new client traffic — counting them would let a long automation chain exhaust the starting key's `requests` quota from the inside and stall mid-flight.

**Residual exemption.** A request that resolves to *no single* project is still not counted: an unscoped key listing across every project it can reach (no `project_id` filter, several projects accessible, or an unscoped admin key with no attached policies) names nothing to count against. Pass a `project_id`, bind the key to a project, or use `tokens`/`cost_usd` quotas — which aggregate from the usage meter independently of the request path — to cap that traffic.

**Capping one specific unscoped key** is not possible: an `api_key`-scope `scope_ref` must name a key that lives in the quota's project, and an unscoped key lives in none. Use a null-`scope_ref` `api_key` quota (or a `project` quota) to cover it.

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
| `on_unpriced`   | string  | `block` \| `allow` — what an `enforce` `cost_usd` quota does over a pricing blackout (see [Unpriced usage](#unpriced-usage)). Defaults to `block`; `null` for metrics with no pricing dependency |
| `current_usage` | object  | Current fixed-window usage for `requests` (`window_key`, `count`, `resets_at`); `null` for token/cost quotas (they aggregate the meter at check time), `null` for `storage_bytes` (a stored total has no window and no counter — read the footprint from the [storage meter](./usage.md#storage-metering)), and `null` in list responses |
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
| `storage_bytes` | `project` |

The exclusions follow from where each metric is measured. `requests` is counted by the request middleware, which sees the API key and the project but not the agent or end user behind the call. `tokens` / `cost_usd` aggregate the [usage meter](./usage.md), which carries project, agent, and end-user attribution but no API-key attribution. `storage_bytes` reads the [storage snapshot](./usage.md#storage-metering), which measures a project's footprint and nothing narrower — a stored byte carries no agent, actor or API-key attribution.

The `window` field is validated the same way, and in both directions: `storage_bytes` accepts `current` and nothing else, and every other metric refuses `current`. Either half stored would be a quota that reads healthy through the API while enforcing nothing — a windowed footprint is never evaluated, and `current` on a flow metric names no window to aggregate over.

### Token and cost enforcement

`tokens` and `cost_usd` quotas are checked **before a generation starts**. The current window's usage is aggregated directly from the [usage meter](./usage.md) — a `cost_usd` quota sums the priced event cost, a `tokens` quota sums the billable token components (uncached input + output + cached; the non-billable `reasoning_tokens` detail is excluded). If the aggregate is at or over the limit, the new generation is blocked with `429 QUOTA_EXCEEDED` and nothing is metered for it.

### Storage enforcement

`storage_bytes` caps what a project **holds**, not what it spends. It is the only metric that bounds an ingesting project: [files](./files.md), document chunks (text *and* vector) and memory entries are all [metered](./usage.md#storage-metering), and without a cap over that figure a project that ingests grows until the disk says no.

A stock shares almost none of the windowed machinery, and the differences are the contract:

| | Flow metrics | `storage_bytes` |
| --- | --- | --- |
| `window` | a fixed window | `current` |
| Aggregate | events inside the window | the project's footprint |
| Breach | `429 QUOTA_EXCEEDED` | `409 QUOTA_STORAGE_EXCEEDED` |
| `Retry-After` | seconds until the window resets | not sent |
| What clears it | the window rolling | deleting stored content |
| `current_usage` | a counter (`requests`) or `null` | `null` |

The `409` follows the precedent [`QUOTA_UNENFORCEABLE`](#unpriced-usage) set: a `429` promises a `Retry-After` a caller can act on, and here waiting is not a remedy. `meta` carries `current_bytes` beside `limit` so the caller knows how much to remove, and omits `resets_at` because there is nothing to reset:

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

Enforcement is on the caller-facing corpus writes, all of them creates — so a refusal leaves nothing half-written:

| Path | Delta counted |
| --- | --- |
| [`POST /api/v1/files/upload`](/docs/api/files/upload-file), [`/upload/base64`](/docs/api/files/upload-file-base-64), [`/upload/{token}`](/docs/api/files/upload-file-with-token) | the uploaded bytes |
| [`POST /api/v1/files`](/docs/api/files/create-file) | the declared `size` — metadata-only, but it is what the meter sums for the row |
| [`POST /api/v1/documents`](/docs/api/documents/create-document) | the `content` bytes |
| [`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document), [`POST /api/v1/documents/{document_id}/ingest`](/docs/api/documents/reingest-document) | none — the source file is already stored and measured; what ingestion adds is chunk text and vectors, produced after the response |
| [`POST /api/v1/memory-entries`](/docs/api/memory-entries/create-memory-entry) | the `content` bytes |

The `document`, `memory_entry` and `file` [formation](./formations.md) resources are held to the same cap, so a template cannot declare what these routes refuse.

**What a generation drives from the inside is deliberately exempt.** Every [conversation](./conversations.md) message is a `Document` with its own chunks and embeddings, and the `write_memory` tool, [automatic extraction](./memories.md) and an [orchestration](./orchestrations.md) `memory_write` node all write memory entries mid-turn. A refusal there would fail a turn already under way and leave it half persisted, which is exactly what the enforcement points above are chosen to avoid. So the cap bounds the ingest surface a tenant drives deliberately, and `monitor`-mode data is what should say whether that is enough.

#### Measured against the last snapshot

The footprint is read from the newest [`storage` event](./usage.md#storage-metering), plus the request's own delta — never from a live scan. The live query joins every chunk row through documents and files: that is a daily-snapshot cost, not a per-upload one. So the cap accepts **up to a day of staleness**, and a burst inside one day spends against a figure that has not heard of it.

Two consequences:

- **A project the sweep has never metered is measured on its delta alone**, so a single upload larger than the whole cap is still refused, and everything smaller is admitted until the first snapshot.
- **The cap is approximate on the way up.** A document's chunks and vectors typically weigh several times its source text ([`chunk_count` and `gb_day`](./usage.md#storage-metering) explain why), and none of that is in the delta — the next snapshot is what sees it. Size the cap for the footprint you are willing to hold, not for the byte the refusal happens to fire on.

**A capped-out project is wedged**: every ingest is refused until a human removes something. That is the trade a cap makes against a retention sweep — it is non-destructive, and `monitor` mode is a real dry run — but it is a trade, so ship a cap in `monitor` mode first and read which projects would breach.

#### Recovering

Delete stored content — [files](./files.md), [documents](./documents.md), [memory entries](./memories.md) — and the next snapshot clears the breach. Deletes are never refused. Raising the cap with [`PATCH /api/v1/quotas/{quota_id}`](/docs/api/quotas/update-quota) clears it immediately, and so does switching the quota to `monitor`. Note that a **re-ingest is refused too**: it re-indexes and can grow the corpus, so it is not an escape from a full one.

### Unpriced usage

A `cost_usd` quota is only as good as the project's pricing. Usage events carry `cost_usd: null` when no [price-book](./usage.md#pricing) row covers them, and an unpriced event contributes `0` to the aggregate. A `tokens` quota has no such dependency: it sums component quantities, which are always recorded.

So a window that metered usage and priced **none** of it aggregates to `0` however much was actually spent, and the limit comparison can never fire. What an `enforce` quota does then is the quota's own declared posture, `on_unpriced`:

- **`block`** (the default) refuses new generations with `409 QUOTA_UNENFORCEABLE`. Asking for a cost cap is asking for spend to be measurable, so the platform holds the project to it rather than reporting a cap that protects nothing.
- **`allow`** lets them through — the operator's explicit choice of availability over containment, recorded on the quota where the next reader can see it.

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

The refusal waits for a real **blackout** — at least 3 metered events in the window, none of them priced. A fresh window's first event can land on the one unpriced model of a mostly-priced project; ordering noise like that must not stop a project at every window boundary, so one or two all-unpriced events pass (the exception below still files) and three with nothing priced refuse.

A **partly** priced window never refuses — the aggregate is real, if incomplete — but it is always **reported**, because a cap enforced on part of its window is not measuring what it caps: a project running a priced model A and an unpriced model B reads A's spend alone, so a `$100` cap passes while `$530` is spent. Refusing on that ratio instead is what an earlier fail-closed verdict got wrong: the refusal blocks the very generation that would have landed the first priced event, which makes the cap unrecoverable rather than safe. The exception below is the whole of the answer.

`unpriced_rows` names what to price, so clearing the refusal does not need a trip through the [rollup](./usage.md#aggregation) to find out which model is missing. It lists the distinct `(provider, model, component)` the window metered and no price row covered, capped at 10 — a component that measured zero is left out, along with a non-billable detail, since pricing either would move no aggregate.

The rows are read per **component**, not per event, which is what makes a **partly priced event** visible: an event's `cost_usd` is the sum of its priced components, so a model with an input-token price and no output-token price produces an event that carries a real number and still understates itself. No comparison of priced events against unpriced ones can see that; `output_tokens` appearing in `unpriced_rows` is what does.

The verdict reads the [`llm_tokens`](./usage.md#meter-types-and-components) meter alone, while the aggregate it guards sums **every** priced meter. A platform meter such as `compute_execution` is priced by the operator from a `soat` SKU rather than by a tenant's provider, so a deployment that prices no compute has not lost the ability to measure AI spend — and counting it would make the cap unrecoverable, because a window holding only unpriced platform events would refuse the very generation that would land the first priced AI event. Reading the AI meter alone also stops a priced platform event from masking a genuine AI blackout.

[Embeddings](./embeddings.md#pricing-embeddings) are held out of the verdict for the same reason, though they are on the AI meter. Their rate is deployment configuration and no price book tier reaches them, so a project cannot make that half of its window priced — counting an embedding unpriced would refuse a cap nobody in the project can satisfy, and counting it priced (an unset rate meters at `0`, which is a priced event) would report the window as measurable and wave through every unpriced generation beside it. Embedding spend still counts towards the aggregate the cap guards, and never appears in `unpriced_rows`.

Worth knowing about the refusal:

- **No `Retry-After`, and no `quota.exceeded` webhook.** The window resetting changes nothing and no limit was reached. Configure the [price book](./usage.md#pricing) for the models in use, or set the quota's `on_unpriced` to `allow`.
- **`monitor` mode never blocks**, here as everywhere, whatever `on_unpriced` says. A project that wants cost visibility without a price book uses `monitor` and gets the exception below and nothing else.
- `on_unpriced` is only storable on `cost_usd` quotas — on any other metric it would be accepted-but-inert, so the write is refused with `400`.

Whatever the posture, a cap that is not measuring what it caps is reported: when a `cost_usd` check finds AI usage in the window that no price row covered, a `quota_unpriced` [exception](./exceptions.md) is filed (severity `warning`) carrying the quota, its limit, how many `llm_tokens` events the window metered, how many of them were unpriced, and the same `unpriced_rows` — from the **first** unpriced row, not the third, so the triage item always precedes any refusal.

A blackout and a partly-priced window file the **same** item: the fix is identical (price those rows), so it is deduped on the quota either way — one degraded cap is one triage item, and its `occurrence_count` is the number of generations that ran under it. An empty window files nothing and refuses nothing, since a zero aggregate with nothing metered is legitimately zero.

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
This differs from `agent` scope, where a null `scope_ref` aggregates the whole project — a pooled all-actors total would just duplicate a `project` quota.
:::

#### Webhook granularity

The `quota.exceeded` webhook fires **once per window per quota**, not once per actor. On a null-ref actor quota that means the first actor to breach in a window fires it and later breaching actors in that same window are silent. Enforcement itself is unaffected — every actor is still checked against their own budget and blocked independently. To see exactly who hit their cap, query the meter with `group_by=actor` (see [Usage](./usage.md)).

### Windows and counters

For the `requests` metric, rolling windows are implemented as fixed windows keyed by the truncated timestamp (`2026-07-07T12:31Z` for `rolling_1m`); `calendar_month` keys are `YYYY-MM`. Each `(quota, window)` is one row incremented with a single atomic `UPDATE … RETURNING`, so counters are correct across server replicas with no coordination. Every request that reaches the middleware increments the counter, including requests that are subsequently rejected.

Two properties follow from that, and they are worth stating separately because they are easy to confuse:

- **Within a window the limit is exact, at any concurrency.** The increment and the limit comparison are the same statement, so a request is always compared against a count that already includes itself and every request that reached the row before it. Requests arriving simultaneously cannot each read a stale count and all be admitted.
- **Across a window boundary the count resets, not decays.** A fixed window is not a sliding one: a `rolling_1m` cap of 60 admits 60 requests at `12:00:59` and 60 more at `12:01:00`. Size a window for the burst you are willing to absorb, or use a longer window with a proportionally larger limit.

### Precedence

When multiple quotas match a request (e.g. a project-wide cap and an API-key cap), **every** `enforce` quota is checked and any breach blocks (fail closed). The most specific scope (`actor` > `agent` > `api_key` > `project`) is the one reported in the error body for attribution; a more specific quota never loosens a broader one. `actor` ranks highest because it names one end user — the narrowest population a cap can address, and so the most actionable thing to report to a caller who was just blocked.

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

Every breach fires a `quota.exceeded` webhook event **once per window**, for both `enforce` and `monitor` quotas. Because a quota's window always has a discrete fixed key and usage only grows within it, the fire state is a single stored key — a breach re-fires only after the window rolls to a new key (no hysteresis). The event `data` carries `quota_id`, `project_id`, `scope`, `scope_ref`, `metric`, `window`, `window_key`, `limit`, `observed_value`, and `mode`. Subscribe a [webhook](./webhooks.md) to `quota.exceeded` (or a wildcard) to receive it.

A `storage_bytes` quota has no window, so the **snapshot's own UTC day** is its `window_key`: one report per fresh measurement while a project stays over cap. A fixed key would report the first breach and then be silent forever, including for a project that deleted content and grew back over.

### Monitor mode

`mode: monitor` observes without blocking: a breach fires the `quota.exceeded` webhook and lets the request (or generation, or corpus write) through. Use it to dry-run a cap before enforcing — flip `mode` to `enforce` via `PATCH` and the next breaching request is blocked. `enforce` quotas fire the same webhook in addition to returning `429`.

Because a monitor breach never blocks, the request it rode in on returns success and leaves no trace beyond the webhook. So a monitor breach also writes a durable [audit-log](./audit-log.md) entry — `action: quotas:MonitorBreach` (no principal authorized it, so `principal_type`/`principal_id` are null), the quota as its resource, and a `detail.kind` of `quota_monitor_breach` carrying the metric, window, limit, and observed value. Like the webhook, it is written once per window. `enforce` breaches need no such entry: they surface as the `429` the audit log already records on the blocked request.

### Formation resource

Quotas can be declared as a `quota` formation resource (`QuotaResourceProperties`): `scope`, `scope_ref`, `metric`, `window`, `limit`, `mode`. The scope × metric and `window` rules above are the same function the REST route calls, so a template cannot declare a combination the API refuses. A `scope_ref` naming an actor can be a `{ "ref": … }` to an actor resource in the same template. Only `limit` and `mode` update through the formation lifecycle. Unknown fields are rejected with `400`.

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

### Cap the stored corpus

Shipped in `monitor` mode first, which is how a storage cap should always start — it reports which projects would breach and refuses nothing.

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
