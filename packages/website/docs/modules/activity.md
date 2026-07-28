---
description: "Cursor-paginated feed of every autonomously executed action, for 'what did agents do today' auditability in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Activity

A cursor-paginated feed of every autonomously executed action.

## Overview

The activity feed answers *"what did agents do today?"* — one entry per autonomous execution: a tool call, an approval resolution, an exception filing, a schedule firing. It is distinct from the [audit log](./audit-log.md): the audit log is **principal-centric** (who authorized a request to the platform — a `user` or `api_key`), while activity is **agent/run-centric** (what an agent did during a run). Security-relevant events (a policy `deny`, a decision-changing guardrail evaluation) stay on the audit log; only autonomous execution telemetry lands here.

There is no public create endpoint — entries are platform-written by producers. The feed is read-only and append-only, and paginated with an opaque cursor rather than offset/limit, because it is high-volume and offset pages shift under a fast-moving feed.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### ActivityEntry

| Field | Type | Description |
|---|---|---|
| `id` | string | Public ID, `acte_` prefix |
| `project_id` | string | Owning project |
| `kind` | string | `action_executed`, `approval_resolved`, `exception_created`, `schedule_fired` |
| `severity` | string | `info`, `warning`, `critical` |
| `summary` | string | Human-readable one-line description |
| `detail` | object \| null | Kind-specific structured context (tool id, node id, generation id, guardrail policy version) |
| `run_id` | string \| null | Originating orchestration run, if any |
| `agent_id` | string \| null | Associated agent, if any |
| `ref_id` | string \| null | Producer-specific reference (the approval, exception, or trigger id the entry came from, or the executed tool's id) |
| `created_at` | string | Append-only timestamp |

`run_id` / `agent_id` / `guardrail_version` are held as bare public ids (not foreign keys), matching [Exceptions](./exceptions.md#exceptionitem)'s provenance convention: the feed has no resolution workflow that needs to join back to those rows. A node id, generation id, or guardrail policy version is carried in `detail` rather than as a dedicated column — only the fields every kind shares (`run_id`, `agent_id`, and the generic `ref_id`) are indexed top-level columns.

## Key Concepts

### Activity vs. the audit log vs. traces

Three surfaces record "what happened," each answering a different question:

| Surface | Question it answers | Subject |
|---|---|---|
| **Activity** (this module) | *What did the agents do?* | the [agent](./agents.md) / [orchestration run](./orchestrations.md) |
| [**Audit log**](./audit-log.md) | *Who did what to the platform, and was it allowed?* | the principal — a [user](./users.md) or [API key](./api-keys.md) |
| [**Traces**](./traces.md) | *How did one generation actually execute?* | a single [generation](./generations.md)'s step-by-step tree |

Activity and the audit log are the pair most easily confused, because both describe things the platform did on its own. The field-level contrast:

| | Activity | [Audit log](./audit-log.md) |
|---|---|---|
| Classifier | `kind` — one of four fixed values; never a permission string | `action` — **is** the [permission-action string](./iam.md#actions) that authorized the request |
| Subject | `run_id`, `agent_id`, `ref_id` — no principal is recorded at all | `principal_type` / `principal_id` ([user](./users.md) / [API key](./api-keys.md)) |
| Target | `ref_id` plus free-form `detail` | [`resource_srn`](./iam.md#soat-resource-names-srns) + `resource_public_id` |
| Outcome | `severity` — records only what **happened** | `status` (HTTP), so **denied attempts are recorded too**, as `403` |
| Request forensics | none | `request_id`, `ip`, `user_agent` |
| Written by | four [producers](#producers) — two event subscriptions, two direct hooks | middleware, once per mutating `/api/v1` request that authorizes |
| Immutability | no update path exists, but it is a convention — not enforced by model hooks | [hard-enforced append-only, with a retention sweep](./audit-log.md#append-only--retention) |
| Reading | keyset [cursor pagination](#cursor-pagination), no export | offset pagination plus [NDJSON export](./audit-log.md#ndjson-export) |

Because the audit log is the compliance surface and this feed is not, security-relevant events stay there even when they look activity-shaped: a [guardrail](./guardrails.md) evaluation that *changed* a call's outcome is mirrored into the audit log as a [system-originated entry](./audit-log.md#system-originated-entries) (`detail.kind: guardrail_evaluation`) — see [Evaluation Audit Record](./guardrails.md#evaluation-audit-record). Only autonomous-execution telemetry lands here.

Neither surface is a superset of the other, and one tool call can legitimately appear in both. A call a guardrail blocked produces an audit record and **no** `action_executed` entry; a call that ran produces an `action_executed` entry, while the audit log separately records the principal authorized to trigger the enclosing request.

### Severity

Severity defaults per kind, and a producer may override it:

| Kind | Default severity | Why |
|---|---|---|
| `action_executed` | `info` | Routine autonomous operation |
| `approval_resolved` | `info` | Routine autonomous operation |
| `exception_created` | `warning` | An exception was already filed — an anomaly, by definition |
| `schedule_fired` | `info` | Routine autonomous operation |

### Cursor pagination

`GET /api/v1/activity` returns `next_cursor` — pass it back as `cursor` to fetch the next page; a `null` `next_cursor` means there is no more data. The cursor is an opaque, keyset (not offset) token encoding a `(created_at, id)` position, so a page never shifts as new entries arrive ahead of it — the failure mode an offset page has on a fast-moving, append-only feed.

### Producers

Each kind is written by a single, dedicated producer:

- **`action_executed`** — emitted after a successful tool call, from two call sites: the orchestration tool-node executor (attributed to the run and node, `agent_id` null) and the agent tool resolver (attributed to the agent and generation, so a tool call an agent makes during a generation — in a [conversation](./conversations.md), a [session](./sessions.md), or a resumed generation — is recorded too). Each call is recorded by exactly one of them: the orchestration path threads no agent identity into the resolver, so a tool node never double-records.

  Recording sits **inside** the [guardrail](./guardrails.md) interceptor and after the tool returns, which is what makes an entry mean the action really ran: a call that was blocked, tripped, or routed to approval never reaches it, and neither does one whose target threw. Two things are deliberately not recorded: [client tools](./tools.md) (no server-side execution, so the platform cannot attest the action happened) and the built-in knowledge-retrieval tools (a [knowledge](./knowledge.md) lookup reads, it does not act).
- **`approval_resolved`** — subscribes to the existing `approvals.approved` / `approvals.rejected` events (see [Approvals](./approvals.md)); no change to that module.
- **`exception_created`** — subscribes to the existing `exceptions.created` event (see [Exceptions](./exceptions.md#producers)); no change to that module.
- **`schedule_fired`** — emitted directly from the trigger scheduler's due-firing sweep, filtered to `source === 'schedule'` only — a manually- or webhook-fired [trigger](./triggers.md) does not produce this kind.

Every producer is fire-and-forget: a recording failure is logged and swallowed, and never disturbs the action it describes — the same "auditing never blocks the request it describes" principle the [audit log](./audit-log.md) follows.

### The feed as a guardrail signal

Because `action_executed` counts real executions, the feed doubles as the platform's autonomous-action **rate** signal: [guardrails](./guardrails.md#guards-and-guardrail-context) read it through `soat.activity.actions_1h` and `soat.activity.actions_24h`, the number of `action_executed` entries in this project over a rolling window ending at evaluation time. That is what lets a guard cap how many actions an agent may take per hour or per day:

```json
{
  "class": "B",
  "guard": { "<": [{ "var": "soat.activity.actions_24h" }, 200] }
}
```

Two consequences of the counting rule are worth knowing when writing such a guard:

- **Only `action_executed` counts.** The other three kinds record what the platform did *about* an action (an approval resolved, an exception filed, a schedule fired), not an action an agent took, so counting them would inflate the rate the ceiling is written against.
- **An empty feed reads as `0`, not unresolved.** A project that has taken no actions yet passes a rate ceiling rather than failing closed on it — unlike the per-run usage keys, "no actions" is a real, meaningful zero. A query that *fails* still fails closed.

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
