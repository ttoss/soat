---
description: "Traces record the full execution history of agent generations — every reasoning step and tool call."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Traces

Traces record the full execution history of agent generations, including every reasoning step and tool call.

## Overview

Every time an agent runs a generation, SOAT automatically records a trace: the sequence of steps the model took, the tools it invoked, the inputs and outputs at each step, and any errors encountered. Traces are stored as JSON files in the project's file storage and indexed in the database for fast retrieval.

Traces support **parent-child relationships**: when an agent spawns a sub-agent (e.g. via a SOAT tool), the child generation creates its own trace linked back to the parent via `parent_trace_id` and the common `root_trace_id`. This allows the full execution tree to be reconstructed.

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
| `step_count`      | number         | Number of reasoning steps recorded                                                     |
| `parent_trace_id` | string \| null | ID of the immediate parent trace; `null` when this trace is itself the root            |
| `root_trace_id`   | string \| null | ID of the root trace in a multi-agent chain; `null` when this trace is itself the root |
| `error`           | object \| null | Structured error payload recorded when a generation in this trace failed; `null` otherwise |
| `content_redacted_at` | string \| null | When the trace's content was purged; `null` while content is intact                |
| `content_redacted_by_principal_type` | string \| null | Principal kind that purged the content (`user` or `api_key`)     |
| `content_redacted_by_principal_id` | string \| null | Public ID of that principal — the key's own id for API-key auth     |
| `created_at`      | string         | ISO 8601 creation timestamp                                                            |

## Key Concepts

### Trace Tree

When agents call other agents (via SOAT tools), each nested generation creates its own trace. All traces in one chain share the same `root_trace_id`. The `GET /traces/:id/tree` endpoint returns the entire tree — the root node with all its descendants nested under `children` — from any trace ID in the chain. See it end to end in [Multi-Agent Sonnet with Nested Agent Calls - Step 12 (Inspect the trace tree)](/docs/tutorials/multi-agent-orchestration#step-12--inspect-the-trace-tree).

### Generation Failures

When a generation in a trace fails (e.g. the upstream AI provider returns an error), the structured error payload is recorded on the trace's `error` field and on the corresponding generation record (`GET /generations/:generation_id`). This makes failed runs distinguishable from runs that have not started yet (which also have `step_count: 0`).

### Step Serialization

Each trace stores the raw step objects produced by the Vercel AI SDK `generateText` call. `Error` instances are serialized to plain objects with `message`, `name`, and any enumerable properties so that errors (e.g. HTTP tool failures) are preserved faithfully in the JSON file.

### File Linkage

Trace content (the step array) is stored as a file at the path `/traces/{traceId}.json` inside the project's file storage. The `file_id` field on the trace record points to this file so it can be downloaded directly via the Files API.

### Content Purge

`DELETE /traces/{trace_id}/content` deletes the trace's steps object **from storage** and clears its content columns, so the content is destroyed rather than merely unreachable. It requires the `traces:PurgeTraceContent` action.

Three properties make the operation useful for an erasure obligation:

- **The row survives as a skeleton.** `content_redacted_at`, the ids, timestamps and `step_count` remain, so a purge is *provable*. A 404 would prove nothing — it is indistinguishable from a resource that never existed. Reads of a purged trace (`GET /traces/{id}` and `GET /traces/{id}/tree`) therefore return the skeleton with the redaction marker set, never a 404.
- **The bytes are deleted, not orphaned.** The purge routes through the storage-aware delete path: it collects the storage locations, commits the row changes, then deletes the objects. A failed object delete is logged for reconciliation rather than rolled back, because the row must stop referencing the bytes before they go — otherwise a concurrent read could reference content mid-delete.
- **It cascades.** Every descendant trace is purged too, along with all of their generations. A descendant holds its own steps object covering the same run, so purging only the named trace would leave that content readable by another path.

The operation is idempotent: purging an already-purged trace succeeds and leaves the original `content_redacted_at` untouched.

What a purge deliberately does **not** touch is the usage and audit ledger. Each cascaded generation keeps its `action_id`, `trigger_id`, `orchestration_run_id`, `node_id`, `agent_version` and `routing`, along with its status and timestamps — billing and audit records must outlive a tenant's erasure of the content. See [Generations](./generations.md#content-purge) for the per-generation operation.

### Retention Policy

A purge on request still depends on someone remembering to ask. Setting `trace_content_retention_days` on a [project](./projects.md) makes it automatic: a daily sweep content-purges every trace in that project older than the window.

```bash
soat update-project --project_id proj_abc --trace_content_retention_days 90
```

- **Opt-in.** `null` is the default and disables retention entirely, so nothing a project already stored is destroyed by enabling the feature elsewhere. Clear it with `--trace_content_retention_days null`.
- **Same purge path.** The sweep calls the same lib function `DELETE /traces/{id}/content` does — the same cascade, the same storage-aware byte deletion, the same `content_redacted_at` semantics, the same audit entries and `traces.content_purged` events. There is no second purge implementation to drift.
- **Scoped to the project, not the agent.** A purge cascades down the trace subtree, and a nested agent call creates a child trace owned by a *different* agent. A per-agent window would therefore let a short-window root silently purge a child whose own agent asked for a longer one. Every trace in a subtree shares one project, so the project-scoped window has no such conflict.
- **A run is purged as a unit.** The sweep selects root traces; when a root crosses the window, its whole subtree goes with it, including children written minutes later. Leaving a child behind would leave the same run's content readable by another path.
- **Auditable, not anonymous.** Sweep-driven purges are stamped `content_redacted_by_principal_type: "system"`, `content_redacted_by_principal_id: "retention_sweep"`, so an automated erasure is distinguishable from one a user requested.

Already-redacted traces are excluded from the due set, so a steady-state sweep costs work proportional to what is newly due rather than to all history.

### Zero-Retention Mode

Retention deletes content after the fact. Zero-retention never writes it. For a regulated tenant, "we never stored it" is a stronger claim than "we deleted it" — content that was never written cannot leak, cannot be missed by a sweep, and cannot sit in a backup.

Set `trace_content_mode` to `none` on a [project](./projects.md) (every agent in it) or on a single [agent](./agents.md#zero-retention):

```bash
soat update-project --project_id proj_abc --trace_content_mode none   # whole project
soat patch-agent --agent_id agent_xyz --trace_content_mode none          # one agent
```

**The project is a floor, the agent may only tighten.** An agent can set `none` under a storing project, but setting `full` under a `none` project is refused with `400`. Otherwise a project-wide mandate could be escaped by creating a new agent under it. An agent's `null` (the default) inherits the project.

#### What is not written

Exactly the field set a [content purge](#content-purge) clears — the two features share one definition, so a field can never be one a purge erases but zero-retention still persists:

| Record | Not written |
| --- | --- |
| Trace | the steps object (no `File` row, no bytes), `error` |
| Generation | `metadata`, `error`, `extraction`, `pending_state` |

#### What is still written

The skeleton, unchanged: ids, timestamps, `status`, `stop_reason`, `step_count`, and every usage-attribution column. Metering never depends on content, so cost, quotas and the audit ledger behave identically in this mode.

Rows written in this mode carry `content_redacted_at` with `content_redacted_by_principal_id: "zero_retention"`. Reusing the purge marker means every existing reader already handles "content is unavailable here"; the principal id is what distinguishes never-stored from stored-then-erased.

#### Trade-off: no recovery after a restart

`pending_state` is the full message history of a generation paused on a client tool, and it is content — so it is not persisted in this mode. A generation still pauses and resumes normally within a running server (that state is held in memory), but **a generation paused when the server restarts cannot be recovered** and will not resume. This is the accepted cost of the mode; if restart-recovery matters more than never-stored, use [retention](#retention-policy) instead.

## Configuration

The retention sweep's schedule (not its per-project window, which is a project field):

| Environment Variable | Required | Description |
| --- | --- | --- |
| `CONTENT_RETENTION_SWEEP_INTERVAL_MS` | No | Sweep interval in milliseconds (default `86400000`, i.e. daily). |
| `CONTENT_RETENTION_SWEEP_DISABLED` | No | Set to `true` to disable the sweep entirely. Projects keep their `trace_content_retention_days`; nothing is purged while it is off. |

## Debugging Joins (Trace, Generation, Session)

When debugging a user flow, there are three related IDs:

- `session_id` (conversation container)
- `generation_id` (single agent execution)
- `trace_id` (observability record for that execution)

What you can resolve directly today:

- From generation responses (`/sessions/.../generate` and auto-generate message responses): `generation_id` + `trace_id`
- From trace APIs: trace metadata (`id`, `agent_id`, `file_id`, `parent_trace_id`, `root_trace_id`)
- From `GET /generations?trace_id=`: all generations linked to a trace

Important limitation:

- Trace records do not include `session_id` directly.

Recommended correlation strategy:

1. Capture (`session_id`, `generation_id`, `trace_id`) when generation responses are returned.
2. Use `trace_id` to inspect trace metadata (`GET /traces/{trace_id}`), structure (`GET /traces/{trace_id}/tree`), and linked generations (`GET /generations?trace_id=`). For a worked example, see [Debug Session, Generation, and Trace History - Step 5 (Inspect traces for each generation)](/docs/tutorials/debug-session-generation-trace-history#step-5---inspect-traces-for-each-generation).
3. Use the session's `conversation_id` to retrieve the full message timeline (`GET /conversations/{conversation_id}/messages`).

This makes both directions deterministic in your own debug records:

- `session_id` -> all `generation_id` values -> each `trace_id`
- `trace_id` -> corresponding `generation_id` and `session_id`

## Trace Ancestry Model

This section is the canonical reference for how trace relationships work. All other SOAT documentation on traces points here.

### Field Definitions

| Field             | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `parent_trace_id` | The `id` of the trace that **directly triggered** this generation. Always the immediate parent — never a grandparent or higher node. |
| `root_trace_id`   | The `id` of the **top-level trace** that started the entire chain. Every trace in a chain shares the same value.                     |

### Invariants

The following properties hold for every trace returned by the API:

1. **Root traces** — `parent_trace_id` is `null` **and** `root_trace_id` is `null`. A trace is the root of its chain if and only if both fields are `null`.
2. **Child traces** — `parent_trace_id` is always the immediate parent (never skipped levels). `root_trace_id` is always the top-level ancestor (never `null` for non-root traces).
3. **Sibling traces** share the same `parent_trace_id` and `root_trace_id`.
4. **Depth-1 children** of the root have `parent_trace_id === root_trace_id`.
5. The `GET /traces/{id}/tree` endpoint accepts any `id` in the chain and always returns the same full tree rooted at the root trace.

### Concrete Example

Consider a three-level chain: Agent A (top level) calls Agent B via a tool, and Agent B calls Agent C:

```
trace_A   (root)
└── trace_B   (child of A)
    └── trace_C   (child of B)
```

The three trace records look like this:

```json
[
  {
    "id": "trace_A",
    "agent_id": "agent_orchestrator",
    "parent_trace_id": null,
    "root_trace_id": null,
    "step_count": 3,
    "created_at": "2025-01-15T10:30:00Z"
  },
  {
    "id": "trace_B",
    "agent_id": "agent_researcher",
    "parent_trace_id": "trace_A",
    "root_trace_id": "trace_A",
    "step_count": 5,
    "created_at": "2025-01-15T10:30:02Z"
  },
  {
    "id": "trace_C",
    "agent_id": "agent_summarizer",
    "parent_trace_id": "trace_B",
    "root_trace_id": "trace_A",
    "step_count": 2,
    "created_at": "2025-01-15T10:30:08Z"
  }
]
```

Key observations:

- `trace_A` is the root: both `parent_trace_id` and `root_trace_id` are `null`.
- `trace_B` is a depth-1 child: `parent_trace_id === root_trace_id === "trace_A"`.
- `trace_C` is a depth-2 child: `parent_trace_id` points to its immediate parent (`trace_B`), while `root_trace_id` still points to the top-level root (`trace_A`).

### Reconstructing the Tree from API Results

**Option 1 — Use the tree endpoint (recommended)**

Supply any trace ID from the chain. The server resolves the root and returns the fully nested tree in one call:

```
GET /api/v1/traces/{any_trace_id}/tree
```

Response shape:

```json
{
  "id": "trace_A",
  "parent_trace_id": null,
  "root_trace_id": null,
  "children": [
    {
      "id": "trace_B",
      "parent_trace_id": "trace_A",
      "root_trace_id": "trace_A",
      "children": [
        {
          "id": "trace_C",
          "parent_trace_id": "trace_B",
          "root_trace_id": "trace_A",
          "children": []
        }
      ]
    }
  ]
}
```

**Option 2 — Build the tree client-side from a flat list**

1. Identify the root: find the trace where `root_trace_id` is `null` (and therefore `parent_trace_id` is also `null`).
2. Group the remaining traces by `parent_trace_id`.
3. Recursively attach children to their parents starting from the root.

```ts
function buildTree(traces) {
  const byId = new Map(traces.map((t) => [t.id, { ...t, children: [] }]));
  let root;
  for (const node of byId.values()) {
    if (!node.parent_trace_id) {
      root = node;
    } else {
      byId.get(node.parent_trace_id)?.children.push(node);
    }
  }
  return root;
}
```

**Option 3 — Follow step content**

Each step in a parent trace that triggered a child generation contains the child's `trace_id` in the tool call result. You can walk the tree by downloading each trace's step file and following the `trace_id` references in `create-agent-generation` tool results.

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

### Get a single trace

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-trace --trace-id trace_abc123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.traces.getTrace({
  path: { trace_id: 'trace_abc123' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/traces/trace_abc123 \
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
