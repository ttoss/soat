---
description: "Triageable failure and anomaly queue with severity, occurrence dedup, and an acknowledge/resolve lifecycle in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Exceptions

A queue of failures and anomalies surfaced as first-class, triageable items rather than log lines.

## Overview

The platform files an **exception** whenever something needs a human's attention — an orchestration run that failed after exhausting retries, a [guardrail](./guardrails.md) tripwire that aborted an action, or an [approval](./approvals.md) that expired without a decision. Each item carries a severity, structured detail, and provenance links, and moves through an `open → acknowledged → resolved` triage lifecycle. Repeated identical failures fold into one item with an occurrence count, so a hot failure loop never floods the queue.

Exceptions are **auto-filed by the platform** (or filed explicitly as `manual`); there is no public create endpoint. They are read, acknowledged, and resolved through the API, and an `exceptions.created` [webhook](./webhooks.md) fires on the first occurrence so alerting is push, not poll.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### ExceptionItem

| Field | Type | Description |
|---|---|---|
| `id` | string | Public ID, `exc_` prefix |
| `project_id` | string | Owning project |
| `status` | string | `open`, `acknowledged`, `resolved` |
| `severity` | string | `info`, `warning`, `critical` |
| `kind` | string | `run_failed`, `guardrail_tripwire`, `approval_expired`, `manual` |
| `title` | string | Human-readable one-line summary |
| `detail` | object \| null | Structured context (tool, error, guardrail version) |
| `occurrence_count` | integer | Times this exact failure was observed while open |
| `last_seen_at` | string | Timestamp of the most recent occurrence |
| `run_id` | string \| null | Originating orchestration run |
| `node_id` | string \| null | Originating node id within the run's graph |
| `agent_id` | string \| null | Associated agent |
| `guardrail_version` | string \| null | `<guardrailId>@<version>` for a `guardrail_tripwire` item |
| `acknowledged_by` | string \| null | Acknowledging user's public ID |
| `resolved_by` | string \| null | Resolving user's public ID |
| `resolution_note` | string \| null | Optional note recorded at resolution |
| `created_at` / `updated_at` | string | Timestamps |

## Key Concepts

### Severity

Severity is keyed to actionability, not raw "badness". Each `kind` has a default a producer can override:

| Kind | Default severity | Why |
|---|---|---|
| `run_failed` | `critical` | A run died after exhausting retries — needs intervention |
| `guardrail_tripwire` | `warning` | The guard worked as designed; also feeds learned rules |
| `approval_expired` | `warning` | Fail-safe missed SLA — the action never ran |
| `manual` | `warning` | Author-chosen |

### Occurrence dedup

Repeated identical failures fold into one **open** item rather than filing duplicates: a partial unique index keys at most one open exception per dedup key, and each recurrence bumps `occurrence_count` and `last_seen_at` (only the first emits `exceptions.created`). A resolved item frees the key, so a recurrence after resolution opens a fresh exception. `manual` items are never deduped.

### Triage lifecycle

An item is `open` when filed. **Acknowledge** it (`acknowledged`) to signal someone is on it — distinct from **resolve** (`resolved`, "fixed"), which records the resolver and an optional note. A resolved item is terminal: acknowledging or resolving it again returns `409 EXCEPTION_ALREADY_RESOLVED`.

### Producers

Exceptions are filed by subscribing to platform events, so producers stay decoupled: `run_failed` rides the existing `orchestration_runs.failed` event, `approval_expired` rides `approvals.expired`, and `guardrail_tripwire` rides a dedicated `guardrail.tripwire` event emitted from the guardrail dispatch path. Every filing is fire-and-forget — it never disturbs the producer.

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
