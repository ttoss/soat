---
description: "Cursor-paginated feed of every autonomously executed action, for 'what did agents do today' auditability in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Activity

A cursor-paginated feed of every autonomously executed action.

## Overview

One entry per autonomous execution: a tool call, an approval resolution, an exception filing, a schedule firing. The [audit log](./audit-log.md) is **principal-centric** (who authorized a request: a `user` or `api_key`); activity is **agent/run-centric**. Security-relevant events (a policy `deny`, a decision-changing guardrail evaluation) stay on the audit log.

No public create endpoint; entries are platform-written. The feed is read-only, append-only, and paginated with an opaque cursor, because offset pages shift under a fast-moving feed.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### ActivityEntry

| Field | Type | Description |
|---|---|---|
| `id` | string | Public ID, `acte_` prefix |
| `project_id` | string | Owning project |
| `kind` | string | `action_executed`, `approval_created`, `approval_resolved`, `exception_created`, `schedule_fired` |
| `severity` | string | `info`, `warning`, `critical` |
| `summary` | string | Human-readable one-line description |
| `detail` | object \| null | Kind-specific structured context (tool id, node id, generation id, guardrail policy version) |
| `orchestration_run_id` | string \| null | Originating orchestration run, if any |
| `agent_id` | string \| null | Associated agent, if any |
| `ref_id` | string \| null | Producer-specific reference (the approval, exception, or trigger id the entry came from, or the executed tool's id) |
| `created_at` | string | Append-only timestamp |

`orchestration_run_id` / `agent_id` / `guardrail_version` are bare public ids, not foreign keys, matching [Exceptions](./exceptions.md#exceptionitem). Node id, generation id, and guardrail policy version live in `detail`; only fields every kind shares (`orchestration_run_id`, `agent_id`, `ref_id`) are indexed columns.

## Key Concepts

### Activity vs. the audit log vs. traces

Three surfaces record what happened:

| Surface | Question it answers | Subject |
|---|---|---|
| **Activity** (this module) | *What did the agents do?* | the [agent](./agents.md) / [orchestration run](./orchestrations.md) |
| [**Audit log**](./audit-log.md) | *Who did what to the platform, and was it allowed?* | the principal — a [user](./users.md) or [API key](./api-keys.md) |
| [**Traces**](./traces.md) | *How did one generation actually execute?* | a single [generation](./generations.md)'s step-by-step tree |

Field-level contrast with the audit log:

| | Activity | [Audit log](./audit-log.md) |
|---|---|---|
| Classifier | `kind` — one of four fixed values; never a permission string | `action` — **is** the [permission-action string](./iam.md#actions) that authorized the request |
| Subject | `orchestration_run_id`, `agent_id`, `ref_id` — no principal is recorded at all | `principal_type` / `principal_id` ([user](./users.md) / [API key](./api-keys.md)) |
| Target | `ref_id` plus free-form `detail` | [`resource_srn`](./iam.md#soat-resource-names-srns) + `resource_public_id` |
| Outcome | `severity` — records only what **happened** | `status` (HTTP), so **denied attempts are recorded too**, as `403` |
| Request forensics | none | `request_id`, `ip`, `user_agent` |
| Written by | four [producers](#producers) — two event subscriptions, two direct hooks | middleware, once per mutating `/api/v1` request that authorizes |
| Immutability | no update path exists, but it is a convention — not enforced by model hooks | [hard-enforced append-only, with a retention sweep](./audit-log.md#append-only--retention) |
| Reading | keyset [cursor pagination](#cursor-pagination), no export | offset pagination plus [NDJSON export](./audit-log.md#ndjson-export) |

Security-relevant events stay on the audit log even when activity-shaped: a [guardrail](./guardrails.md) evaluation that *changed* a call's outcome is mirrored as a [system-originated entry](./audit-log.md#system-originated-entries) (`detail.kind: guardrail_evaluation`); see [Evaluation Audit Record](./guardrails.md#evaluation-audit-record).

Neither is a superset of the other. A call a guardrail blocked produces an audit record and **no** `action_executed` entry; a call that ran produces an `action_executed` entry while the audit log records the principal who triggered the enclosing request.

### Severity

Severity defaults per kind, and a producer may override it:

| Kind | Default severity | Why |
|---|---|---|
| `action_executed` | `info` | Routine autonomous operation |
| `approval_created` | `info` | An approval waiting on a human is routine autonomous operation |
| `approval_resolved` | `info` | Routine autonomous operation |
| `exception_created` | `warning` | An exception was already filed — an anomaly, by definition |
| `schedule_fired` | `info` | Routine autonomous operation |

`exception_created` **inherits the filed [exception](./exceptions.md#severity)'s severity**, so a `run_failed` exception (`critical`) records a `critical` entry; the `warning` default applies only when the event carries no recognized severity. This is the only path that writes `critical`, so `severity=critical` surfaces entries a `kind` filter cannot.

### Cursor pagination

[`GET /api/v1/activity`](/docs/api/activity/list-activity) returns `next_cursor`; pass it back as `cursor`. `null` means no more data. The cursor is an opaque keyset token over `(created_at, id)`, so a page never shifts as entries arrive.

### Retention

Entries are kept **indefinitely**: no delete endpoint and, unlike the [audit log](./audit-log.md#append-only--retention), no pruning sweep, so `activity_entries` grows with execution volume.

Nothing reads aged entries: [guardrail rate keys](#the-feed-as-a-guardrail-signal) count a rolling 1-hour or 24-hour window and the feed pages newest-first, so pruning out of band is safe.

### Producers

One producer per kind:

- **`action_executed`** — after a successful tool call, from the orchestration tool-node executor (attributed to run and node, `agent_id` null) or the agent tool resolver (attributed to agent and generation, covering [conversation](./conversations.md), [session](./sessions.md), and resumed generations). The orchestration path threads no agent identity into the resolver, so a tool node never double-records.

  Recording sits **inside** the [guardrail](./guardrails.md) interceptor, after the tool returns: a call blocked, tripped, routed to approval, or whose target threw is never recorded. Not recorded: [client tools](./tools.md) (no server-side execution to attest) and the built-in knowledge-retrieval tools (a [knowledge](./knowledge.md) lookup reads, it does not act).
- **`approval_created`** — subscribes to `approvals.created` ([Approvals](./approvals.md)), filed while the approval is pending. `approvals.expired` is not filed.
- **`approval_resolved`** — subscribes to `approvals.approved` / `approvals.rejected`.
- **`exception_created`** — subscribes to `exceptions.created` ([Exceptions](./exceptions.md#producers)).
- **`schedule_fired`** — from the trigger scheduler's due-firing sweep, `source === 'schedule'` only; a manual or webhook [trigger](./triggers.md) fire does not produce it.

Every producer is fire-and-forget: a recording failure is logged and never disturbs the action, as in the [audit log](./audit-log.md).

### The feed as a guardrail signal

`action_executed` counts real executions, so [guardrails](./guardrails.md#guards-and-guardrail-context) read it through `runtime.activity.actions_1h` and `runtime.activity.actions_24h` (entries in this project over a rolling window ending at evaluation time) to cap actions per hour or day:

```json
{
  "class": "B",
  "guard": { "<": [{ "var": "runtime.activity.actions_24h" }, 200] }
}
```

- **Only `action_executed` counts.** The other kinds record what the platform did *about* an action.
- **An empty feed reads as `0`**, so a project with no actions yet passes a rate ceiling; unlike per-run usage keys, "no actions" is a real zero. A query that *fails* still fails closed.

## Examples

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-activity --project-id proj_01 --kind exception_created

# Follow with the returned cursor to page forward
soat list-activity --project-id proj_01 --cursor <next_cursor>
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.activity.listActivity({
  query: { project_id: 'proj_01', severity: 'warning' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X GET "https://api.example.com/api/v1/activity?project_id=proj_01&kind=schedule_fired" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
