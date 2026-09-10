---
description: "Triageable failure and anomaly queue with severity, occurrence dedup, and an acknowledge/resolve lifecycle in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Exceptions

Failures and anomalies as first-class triageable items.

## Overview

The platform files an **exception** when something needs a human: an orchestration run failed after retries, a [guardrail](./guardrails.md) tripwire aborted an action, an [approval](./approvals.md) expired. Each carries severity, structured detail, provenance links, and an `open → acknowledged → resolved` lifecycle. Identical failures fold into one item with an occurrence count.

Exceptions are **auto-filed** (or filed as `manual`); there is no public create endpoint. They are read, acknowledged, and resolved through the API; `exceptions.created` fires a [webhook](./webhooks.md) on first occurrence.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Gate a Dangerous Tool with Guardrails - Step 10 (A failing guard files a tripwire exception)](/docs/tutorials/gate-a-tool-with-guardrails#step-10--a-failing-guard-the-tripwire)
- [Cap Spend Per End User - Step 10 (A cost cap with no prices protects nothing)](/docs/tutorials/cap-spend-per-end-user#step-10--a-cost-cap-with-no-prices-protects-nothing)

## Data Model

### ExceptionItem

| Field | Type | Description |
|---|---|---|
| `id` | string | Public ID, `exc_` prefix |
| `project_id` | string | Owning project |
| `status` | string | `open`, `acknowledged`, `resolved` |
| `severity` | string | `info`, `warning`, `critical` |
| `kind` | string | `run_failed`, `guardrail_tripwire`, `approval_expired`, `quota_unpriced`, `event_trigger_loop`, `chain_limit`, `manual` |
| `title` | string | Human-readable one-line summary |
| `detail` | object \| null | Structured context (tool, error, guardrail version) |
| `occurrence_count` | integer | Times this exact failure was observed while open |
| `last_seen_at` | string | Timestamp of the most recent occurrence |
| `orchestration_run_id` | string \| null | Originating orchestration run |
| `node_id` | string \| null | Originating node id within the run's graph |
| `agent_id` | string \| null | Associated agent |
| `guardrail_version` | string \| null | `<guardrailId>@<version>` for a `guardrail_tripwire` item |
| `acknowledged_by` | string \| null | Acknowledging user's public ID |
| `resolved_by` | string \| null | Resolving user's public ID |
| `resolution_note` | string \| null | Optional note recorded at resolution |
| `created_at` / `updated_at` | string | Timestamps |

## Key Concepts

### Severity

Severity is keyed to actionability. Each `kind` has a default a producer may override:

| Kind | Default severity | Why |
|---|---|---|
| `run_failed` | `critical` | A run died after exhausting retries — needs intervention |
| `guardrail_tripwire` | `warning` | The guard worked as designed; also a feedback-loop signal |
| `approval_expired` | `warning` | Fail-safe missed SLA — the action never ran |
| `quota_unpriced` | `warning` | A cost cap is measuring less than it caps; needs a config fix, not incident response |
| `event_trigger_loop` | `warning` | The causation guard stopped a self-feeding [event trigger](./triggers.md#loops-and-cost); the wiring still needs a human |
| `chain_limit` | `warning` | A [continuation chain](./chains.md) spent its generation budget — the guard stopped it, and an agent that cannot terminate on its own still needs a human |
| `manual` | `warning` | Author-chosen |

### Occurrence dedup

Identical failures fold into one **open** item: a partial unique index keys at most one open exception per dedup key; recurrences bump `occurrence_count` and `last_seen_at` (only the first emits `exceptions.created`). Resolving frees the key, so a later recurrence opens a fresh item. `manual` items are never deduped.

### Triage lifecycle

Filed as `open`. **Acknowledge** (`acknowledged`) signals someone is on it; **resolve** (`resolved`) records the resolver and optional note and is terminal: acknowledging or resolving again returns `409 EXCEPTION_ALREADY_RESOLVED`.

### Producers

Producers subscribe to platform events: `run_failed` rides `orchestration_runs.failed`, `approval_expired` rides `approvals.expired`, `guardrail_tripwire` rides `guardrail.tripwire` from the guardrail dispatch path. Filing is fire-and-forget.

`event_trigger_loop` is filed by the [event-trigger](./triggers.md#loops-and-cost) dispatcher when a trigger refuses to extend the causal chain that reached it (the chain already names it, or is past the depth cap). Deduped on trigger and reason, so `occurrence_count` is how often it was refused; `detail` carries the chain and event name, the only place that wiring is visible (events are not persisted).

`chain_limit` is filed when a [continuation chain](./chains.md) is refused for spending its generation budget. It rides `generations.chain_limit` and is deduped on the chain's **root generation**, the id every refusal in a chain shares. `detail` carries the root, the initiator of the refused turn, the chain's size, the budget hit, and `limit_source`: `agent` ([`max_chain_generations`](./agents.md#stop-conditions) on the agent), `project` ([`max_chain_generations`](./projects.md) on the project), or `platform` (the deployment ceiling). The refusal itself is recorded on a trace and returned to a caller that is usually a background sweep; the exception is what reaches a human.

`quota_unpriced` is filed inline from the [quota](./quotas.md#token-and-cost-enforcement) pre-generation check, the only place that knows a cost cap evaluated against a window whose usage was not fully priced. Nothing priced and partly priced file the same item (the fix is the price rows named in `unpriced_rows`), deduped on the quota, so `occurrence_count` is the number of generations run under the degraded cap. The check fails open; a filing error never blocks a generation.

## Examples

<Tabs groupId="client">
<TabItem value="cli" label="CLI">

```bash
# List open, critical exceptions in a project
soat list-exceptions --project-id proj_01 --status open --severity critical

# Triage one
soat acknowledge-exception --exception-id exc_01
soat resolve-exception --exception-id exc_01 --note "Root cause fixed; reran the pipeline."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: exceptions } = await client.GET('/api/v1/exceptions', {
  params: { query: { project_id: 'proj_01', status: 'open' } },
});

await client.POST('/api/v1/exceptions/{exception_id}/resolve', {
  params: { path: { exception_id: 'exc_01' } },
  body: { note: 'Root cause fixed.' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -H "Authorization: Bearer $SOAT_TOKEN" \
  "$SOAT_BASE_URL/api/v1/exceptions?project_id=proj_01&status=open"

curl -X POST -H "Authorization: Bearer $SOAT_TOKEN" \
  -H "Content-Type: application/json" -d '{"note":"Root cause fixed."}' \
  "$SOAT_BASE_URL/api/v1/exceptions/exc_01/resolve"
```

</TabItem>
</Tabs>
