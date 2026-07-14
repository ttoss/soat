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
