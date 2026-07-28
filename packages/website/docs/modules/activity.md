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

- **`action_executed`** — emitted directly from the orchestration tool-node executor after a successful tool call. **Known v1 gap:** only orchestration tool nodes are instrumented; agent-generation-time tool calls (conversation/session tool-call content blocks, the pipeline-tool resolver used during agent generation) are not yet wired — the agent identity is not threaded through that call path today. Tracked as follow-up work, not silently dropped.
- **`approval_resolved`** — subscribes to the existing `approvals.approved` / `approvals.rejected` events (see [Approvals](./approvals.md)); no change to that module.
- **`exception_created`** — subscribes to the existing `exceptions.created` event (see [Exceptions](./exceptions.md#producers)); no change to that module.
- **`schedule_fired`** — emitted directly from the trigger scheduler's due-firing sweep, filtered to `source === 'schedule'` only — a manually- or webhook-fired [trigger](./triggers.md) does not produce this kind.

Every producer is fire-and-forget: a recording failure is logged and swallowed, and never disturbs the action it describes — the same "auditing never blocks the request it describes" principle the [audit log](./audit-log.md) follows.

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
