---
description: "Traces record the full execution history of agent generations — every reasoning step and tool call."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Traces

Traces record the full execution history of agent generations, including every reasoning step and tool call.

## Overview

Every time an agent runs a generation, SOAT automatically records a trace: the sequence of steps the model took, the tools it invoked, the inputs and outputs at each step, and any errors encountered. Traces are stored as JSON files in the project's file storage and indexed in the database for fast retrieval. Traces support parent-child relationships, so the full execution tree of a multi-agent run can be reconstructed — see the [Trace Ancestry Model](#trace-ancestry-model).

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
| `root_trace_id`   | string \| null | ID of the root trace in a multi-agent chain; `null` when this trace is itself the root |
| `error`           | object \| null | Structured error payload recorded when a generation in this trace failed; `null` otherwise |
| `content_redacted_at` | string \| null | When the trace's content was purged; `null` while content is intact                |
| `content_redacted_by_principal_type` | string \| null | Principal kind that purged the content (`user` or `api_key`)     |
| `content_redacted_by_principal_id` | string \| null | Public ID of that principal — the key's own id for API-key auth     |
| `created_at`      | string         | ISO 8601 creation timestamp                                                            |

## Key Concepts

### Generation Failures

When a generation in a trace fails (e.g. the upstream AI provider returns an error), the structured error payload is recorded on the trace's `error` field and on the corresponding generation record. This makes failed runs distinguishable from runs that have not started yet (which also have `step_count: 0`).

### Step Serialization and File Linkage

Each trace stores the raw step objects produced by the Vercel AI SDK `generateText` call, as a file at `/traces/{traceId}.json` in the project's file storage; `file_id` points to it, so it can be downloaded via the Files API. `Error` instances are serialized to plain objects (`message`, `name`, enumerable properties) so tool failures are preserved faithfully.

### Grouping Generations Under One Trace

`POST /agents/{agent_id}/generate` accepts a `trace_id`. Passing one that already exists groups the new generation with the earlier ones instead of starting a chain — use it when several turns are one logical run and `parent_trace_id` / `root_trace_id` would misrepresent them as nested calls.

- **The steps object is the concatenation of every grouped generation's steps**, in the order the generations first wrote. A second generation appends; it never replaces what the first one recorded.
- **`step_count` counts them all**, so it stays the length of the object `file_id` points at.
- **A generation that writes twice rewrites only its own slice.** This is what a run paused on a client tool does: the tool-outputs continuation re-sends the turn's earlier steps along with the new ones, and they replace — rather than duplicate — the ones already recorded.
- **Sub-agent calls are not grouping.** An agent-to-agent call gets a trace of its own, linked through `parent_trace_id` / `root_trace_id` — see [Trace Ancestry Model](#trace-ancestry-model).

Concurrent generations sharing one `trace_id` are serialized per server process. If several servers write to the same `trace_id` at the same moment, one turn's steps can still be lost; sequential turns — the ordinary grouping flow — are unaffected.

### Reading a Turn Back

The steps object is the raw record, in the `ai` package's own shape. To read a turn
without parsing it yourself, use the generation's transcript — an ordered projection of
the same steps into a documented, stable schema:

```bash
soat get-generation-transcript --generation_id gen_abc
```

A transcript is scoped to one **turn**, which is why it is anchored on the generation
rather than here: a trace can hold several generations, and `status`, `stop_reason` and
`agent_version` are generation fields. A transcript reads back only the steps of its own
generation's segment, so grouping several turns under one `trace_id` does not blur them
together. See [Generations → Transcript](./generations.md#transcript).

### Debugging Joins (Trace, Generation, Session)

Generation responses carry `generation_id` + `trace_id`; `GET /generations?trace_id=` returns all generations linked to a trace. Trace records do **not** include `session_id` — capture (`session_id`, `generation_id`, `trace_id`) from generation responses at your own boundary to correlate in both directions. See [Debug Session, Generation, and Trace History - Step 5](/docs/tutorials/debug-session-generation-trace-history#step-5---inspect-traces-for-each-generation).

### Content Purge

`DELETE /traces/{trace_id}/content` deletes the trace's steps object **from storage** and clears its content columns. It requires the `traces:PurgeTraceContent` action.

- **The row survives as a skeleton.** `content_redacted_at`, the ids, timestamps and `step_count` remain, so a purge is provable. Reads of a purged trace return the skeleton with the redaction marker set, never a 404.
- **The bytes are deleted, not orphaned.** The purge commits the row changes, then deletes the storage objects; a failed object delete is logged for reconciliation rather than rolled back.
- **It cascades.** Every descendant trace is purged too, along with all of their generations — a descendant holds its own steps object covering the same run.

The operation is idempotent: purging an already-purged trace succeeds and leaves the original `content_redacted_at` untouched. A purge does **not** touch the usage and audit ledger: each cascaded generation keeps `action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version`, `routing`, status and timestamps. See [Generations](./generations.md#content-purge) for the per-generation operation.

### Retention Policy

Setting `trace_content_retention_days` on a [project](./projects.md) makes purging automatic: a daily sweep content-purges every trace in that project older than the window.

```bash
soat update-project --project_id proj_abc --trace_content_retention_days 90
```

- **Opt-in.** `null` (the default) disables retention. Clear it with `--trace_content_retention_days null`.
- **Same purge path** as `DELETE /traces/{id}/content` — same cascade, byte deletion, `content_redacted_at` semantics, audit entries and `traces.content_purged` events.
- **Scoped to the project, not the agent** — every trace in a subtree shares one project, so a project-scoped window cannot conflict across a nested call the way a per-agent window would.
- **A run is purged as a unit.** The sweep selects root traces; when a root crosses the window, its whole subtree goes with it.
- **Auditable.** Sweep-driven purges are stamped `content_redacted_by_principal_type: "system"`, `content_redacted_by_principal_id: "retention_sweep"`.

Already-redacted traces are excluded from the due set, so a steady-state sweep costs work proportional to what is newly due.

### Zero-Retention Mode

Retention deletes content after the fact; zero-retention never writes it. Set `trace_content_mode` to `none` on a [project](./projects.md) (every agent in it) or on a single [agent](./agents.md#zero-retention):

```bash
soat update-project --project_id proj_abc --trace_content_mode none   # whole project
soat patch-agent --agent_id agent_xyz --trace_content_mode none          # one agent
```

**The project is a floor, the agent may only tighten**: an agent can set `none` under a storing project, but setting `full` under a `none` project is refused with `400`. An agent's `null` (the default) inherits the project.

What is **not written** is exactly the field set a [content purge](#content-purge) clears — the two features share one definition:

| Record | Not written |
| --- | --- |
| Trace | the steps object (no `File` row, no bytes), `error` |
| Generation | `metadata`, `error`, `extraction`, `pending_state` |

The skeleton is still written unchanged: ids, timestamps, `status`, `stop_reason`, `step_count`, and every usage-attribution column — metering, cost, quotas and audit behave identically. Rows written in this mode carry `content_redacted_at` with `content_redacted_by_principal_id: "zero_retention"`, distinguishing never-stored from stored-then-erased.

**Trade-off:** `pending_state` (the message history of a generation paused on a client tool) is content, so it is not persisted. A paused generation resumes normally within a running server, but **a generation paused when the server restarts cannot be recovered**. If restart-recovery matters more than never-stored, use [retention](#retention-policy) instead.

## Configuration

The retention sweep's schedule (not its per-project window, which is a project field):

| Environment Variable | Required | Description |
| --- | --- | --- |
| `CONTENT_RETENTION_SWEEP_INTERVAL_MS` | No | Sweep interval in milliseconds (default `86400000`, i.e. daily). |
| `CONTENT_RETENTION_SWEEP_DISABLED` | No | Set to `true` to disable the sweep entirely. Projects keep their `trace_content_retention_days`; nothing is purged while it is off. |

## Trace Ancestry Model

This section is the canonical reference for how trace relationships work. All other SOAT documentation on traces points here.

### Field Definitions

| Field             | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `parent_trace_id` | The `id` of the trace that **directly triggered** this generation. Always the immediate parent — never a grandparent or higher node. |
| `root_trace_id`   | The `id` of the **top-level trace** that started the entire chain. Every trace in a chain shares the same value.                     |

### Invariants

1. **Root traces** — `parent_trace_id` is `null` **and** `root_trace_id` is `null`. A trace is the root of its chain if and only if both fields are `null`.
2. **Child traces** — `parent_trace_id` is always the immediate parent (never skipped levels). `root_trace_id` is always the top-level ancestor (never `null` for non-root traces).
3. **Sibling traces** share the same `parent_trace_id` and `root_trace_id`.
4. **Depth-1 children** of the root have `parent_trace_id === root_trace_id`.
5. The `GET /traces/{id}/tree` endpoint accepts any `id` in the chain and always returns the same full tree rooted at the root trace.

### Concrete Example

A three-level chain — Agent A (top level) calls Agent B via a tool, and Agent B calls Agent C:

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

Note `trace_C`: `parent_trace_id` points to its immediate parent (`trace_B`), while `root_trace_id` still points to the top-level root (`trace_A`).

### Reconstructing the Tree

**Recommended:** supply any trace ID from the chain to the tree endpoint; the server resolves the root and returns the fully nested tree (root node with descendants under `children`) in one call:

```
GET /api/v1/traces/{any_trace_id}/tree
```

Alternatively, build it client-side from a flat list: the root is the trace with `root_trace_id: null`; group the rest by `parent_trace_id` and attach recursively. Steps in a parent trace that triggered a child generation also contain the child's `trace_id` in the `create-agent-generation` tool result, so the tree can be walked through step content.

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
