---
description: "Traces record the full execution history of agent generations — every reasoning step and tool call."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Traces

Traces record the full execution history of agent generations, including every reasoning step and tool call.

## Overview

Every agent generation records a trace: the model's steps, tool invocations, inputs, outputs and errors. Traces are stored as JSON files in the project's file storage and indexed in the database. Parent-child links reconstruct a multi-agent run's tree; see the [Trace Ancestry Model](#trace-ancestry-model).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Debug Session, Generation, and Trace History - Step 5 (Inspect traces for each generation)](/docs/tutorials/debug-session-generation-trace-history#step-5---inspect-traces-for-each-generation)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 12 (Inspect the trace tree)](/docs/tutorials/multi-agent-orchestration#step-12--inspect-the-trace-tree)
- [Deploy a Multi-Agent App with Agent Formation - Step 9 (Inspect the trace tree)](/docs/tutorials/formations#step-9--inspect-the-trace-tree)
- [Data Retention and Zero-Retention - Step 4 (Purge the trace on request)](/docs/tutorials/data-retention-and-zero-retention#step-4--purge-the-trace-on-request)

## Data Model

| Field             | Type           | Description                                                                            |
| ----------------- | -------------- | -------------------------------------------------------------------------------------- |
| `id`              | string         | Public identifier for the trace                                                        |
| `project_id`      | string         | Project the trace belongs to                                                           |
| `agent_id`        | string         | Agent that produced the trace                                                          |
| `file_id`         | string \| null | ID of the file containing the serialized steps (JSON array)                            |
| `step_count`      | number         | Number of reasoning steps recorded, across every generation grouped under the trace    |
| `parent_trace_id` | string \| null | ID of the immediate parent trace; `null` when this trace is itself the root            |
| `root_trace_id`   | string \| null | ID of the root trace in a multi-agent call tree; `null` when this trace is itself the root |
| `error`           | object \| null | Structured error payload recorded when a generation in this trace failed; `null` otherwise |
| `content_redacted_at` | string \| null | When the trace's content was purged; `null` while content is intact                |
| `content_redacted_by_principal_type` | string \| null | Principal kind that purged the content (`user` or `api_key`)     |
| `content_redacted_by_principal_id` | string \| null | Public ID of that principal — the key's own id for API-key auth     |
| `created_at`      | string         | ISO 8601 creation timestamp                                                            |

## Key Concepts

### Generation Failures

When a generation fails (e.g. a provider error), the structured error is recorded on the trace's `error` field and on the generation record, distinguishing failed runs from not-yet-started ones (both `step_count: 0`).

### Step Serialization and File Linkage

Raw step objects from the Vercel AI SDK `generateText` call are stored at `/traces/{traceId}.json` in the project's file storage; `file_id` points to it (downloadable via the Files API). `Error` instances are serialized to plain objects (`message`, `name`, enumerable properties).

### Reading a Turn Back

The steps object is in the `ai` package's own shape. The generation's transcript is an
ordered projection of the same steps into a stable schema:

```bash
soat get-generation-transcript --generation_id gen_abc
```

A transcript is scoped to one **turn** (a trace can hold several generations; `status`,
`stop_reason` and `agent_version` are generation fields) and reads back only its own
generation's segment. See [Generations → Transcript](./generations.md#transcript).

### Grouping Generations Under One Trace

[`POST /agents/{agent_id}/generate`](/docs/api/agents/create-agent-generation) accepts a `trace_id`; an existing one groups the new generation with the earlier ones. Use it when several turns are one logical run rather than nested calls.

- **The steps object concatenates every grouped generation's steps**, in first-write order; a second generation appends.
- **`step_count` counts them all**, matching the object `file_id` points at.
- **A generation that writes twice rewrites only its own slice** (a tool-outputs continuation re-sends the turn's earlier steps with the new ones; they replace, not duplicate).
- **Sub-agent calls are not grouping**; they get their own trace linked through `parent_trace_id` / `root_trace_id` (see [Trace Ancestry Model](#trace-ancestry-model)).

Read one grouped turn via its [transcript](#reading-a-turn-back).

Concurrent generations on one `trace_id` are serialized per server process; simultaneous writes from several servers can lose one turn's steps. Sequential turns are unaffected.

### Debugging Joins (Trace, Generation, Session)

Generation responses carry `generation_id` + `trace_id`; [`GET /generations?trace_id=`](/docs/api/generations/list-generations) lists a trace's generations. Traces do **not** include `session_id`; capture (`session_id`, `generation_id`, `trace_id`) from generation responses to correlate both ways. See [Debug Session, Generation, and Trace History - Step 5](/docs/tutorials/debug-session-generation-trace-history#step-5---inspect-traces-for-each-generation).

### Content Purge

[`DELETE /traces/{trace_id}/content`](/docs/api/traces/purge-trace-content) deletes the steps object **from storage** and clears the content columns. Requires `traces:PurgeTraceContent`.

- **The row survives as a skeleton**: `content_redacted_at`, ids, timestamps and `step_count` remain. Reads return the skeleton, never a 404.
- **The bytes are deleted.** Row changes commit, then storage objects are deleted; a failed object delete is logged for reconciliation, not rolled back.
- **It cascades** to every descendant trace and their generations.

Idempotent: re-purging leaves the original `content_redacted_at` untouched. The usage and audit ledger is untouched: each cascaded generation keeps `action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version`, `routing`, status and timestamps. Per-generation operation: [Generations](./generations.md#content-purge).

### Retention Policy

`trace_content_retention_days` on a [project](./projects.md) makes a daily sweep content-purge every trace older than the window. The sweep also runs once at server startup.

```bash
soat update-project --project_id proj_abc --trace_content_retention_days 90
```

- **Opt-in.** `null` (default) disables retention; clear with `--trace_content_retention_days null`.
- **Same purge path** as [`DELETE /traces/{id}/content`](/docs/api/traces/purge-trace-content): cascade, byte deletion, `content_redacted_at`, audit entries and `traces.content_purged` events.
- **Scoped to the project, not the agent**, so a window cannot conflict across a nested call.
- **A run is purged as a unit.** The sweep selects root traces; a root crossing the window takes its subtree.
- **Auditable.** Stamped `content_redacted_by_principal_type: "system"`, `content_redacted_by_principal_id: "retention_sweep"`.

Already-redacted traces are excluded from the due set.

### Zero-Retention Mode

Zero-retention never writes content. Set `trace_content_mode` to `none` on a [project](./projects.md) (every agent in it) or a single [agent](./agents.md#zero-retention):

```bash
soat update-project --project_id proj_abc --trace_content_mode none   # whole project
soat patch-agent --agent_id agent_xyz --trace_content_mode none          # one agent
```

**The project is a floor; the agent may only tighten**: `full` under a `none` project is refused with `400`. An agent's `null` (default) inherits the project.

What is **not written** is exactly the field set a [content purge](#content-purge) clears:

| Record | Not written |
| --- | --- |
| Trace | the steps object (no `File` row, no bytes), `error` |
| Generation | `metadata`, `error`, `extraction`, `pending_state` |

The skeleton is still written: ids, timestamps, `status`, `stop_reason`, `step_count`, and every usage-attribution column, so metering, cost, quotas and audit are unchanged. Rows carry `content_redacted_at` with `content_redacted_by_principal_id: "zero_retention"`.

**Trade-off:** `pending_state` (the message history of a generation paused on a client tool) is content and is not persisted, so **a generation paused across a server restart cannot be recovered**. If that matters, use [retention](#retention-policy) instead.

## Configuration

The retention sweep's schedule (the per-project window is a project field):

| Environment Variable | Required | Description |
| --- | --- | --- |
| `CONTENT_RETENTION_SWEEP_INTERVAL_MS` | No | Sweep interval in milliseconds (default `86400000`, i.e. daily). |
| `CONTENT_RETENTION_SWEEP_DISABLED` | No | Set to `true` to disable the sweep entirely. Projects keep their `trace_content_retention_days`; nothing is purged while it is off. |

## Trace Ancestry Model

Canonical reference for trace relationships.

> **Trace lineage is not a [continuation chain](./chains.md).** Lineage runs
> **inward**, through the calls one turn makes within a single request, bounded
> by `max_call_depth`. A chain runs **forward in time**, through turns resumed
> after their request is gone, bounded by the chain budget. A chain is keyed on
> its root *generation*, not on lineage, because lineage is rewritten by
> unrelated operations (deleting an agent nulls the trace parentage beneath it).

### Field Definitions

| Field             | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `parent_trace_id` | The `id` of the trace that **directly triggered** this generation. Always the immediate parent — never a grandparent or higher node. |
| `root_trace_id`   | The `id` of the **top-level trace** that started the entire tree. Every trace in a tree shares the same value.                       |

### Invariants

1. **Root traces** — `parent_trace_id` and `root_trace_id` are both `null` (iff).
2. **Child traces** — `parent_trace_id` is the immediate parent; `root_trace_id` is the top-level ancestor (never `null` for non-root traces).
3. **Sibling traces** share the same `parent_trace_id` and `root_trace_id`.
4. **Depth-1 children** of the root have `parent_trace_id === root_trace_id`.
5. The [`GET /traces/{id}/tree`](/docs/api/traces/get-trace-tree) endpoint accepts any `id` in the tree and always returns the same full tree rooted at the root trace.

### Concrete Example

Agent A calls Agent B via a tool; Agent B calls Agent C:

```
trace_A   (root)
└── trace_B   (child of A)
    └── trace_C   (child of B)
```

```json
[
  {
    "id": "trace_A",
    "agent_id": "agent_orchestrator",
    "parent_trace_id": null,
    "root_trace_id": null
  },
  {
    "id": "trace_B",
    "agent_id": "agent_researcher",
    "parent_trace_id": "trace_A",
    "root_trace_id": "trace_A"
  },
  {
    "id": "trace_C",
    "agent_id": "agent_summarizer",
    "parent_trace_id": "trace_B",
    "root_trace_id": "trace_A"
  }
]
```

`trace_C`: `parent_trace_id` is `trace_B`, `root_trace_id` is `trace_A`.

### Reconstructing the Tree

**Recommended:** pass any trace ID to the tree endpoint; it returns the nested tree (descendants under `children`) in one call:

```
GET /api/v1/traces/{any_trace_id}/tree
```

Or build it client-side: the root has `root_trace_id: null`; group the rest by `parent_trace_id` and attach recursively. A parent's `create-agent-generation` tool result also contains the child's `trace_id`.

## Examples

### List traces

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-traces --project-id proj_abc123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.traces.listTraces({
  query: { project_id: 'proj_abc123' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/traces?project_id=proj_abc123" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Get the full trace tree

Includes nested sub-agent traces under `children`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-trace-tree --trace-id trace_abc123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.traces.getTraceTree({
  path: { trace_id: 'trace_abc123' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/traces/trace_abc123/tree \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
