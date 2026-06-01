import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Traces

Traces record the full execution history of agent generations, including every reasoning step and tool call.

## Overview

Every time an agent runs a generation, SOAT automatically records a trace: the sequence of steps the model took, the tools it invoked, the inputs and outputs at each step, and any errors encountered. Traces are stored as JSON files in the project's file storage and indexed in the database for fast retrieval.

Traces support **parent-child relationships**: when an agent spawns a sub-agent (e.g. via a SOAT tool), the child generation creates its own trace linked back to the parent via `parent_trace_id` and the common `root_trace_id`. This allows the full execution tree to be reconstructed.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

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
| `created_at`      | string         | ISO 8601 creation timestamp                                                            |

## Key Concepts

### Trace Tree

When agents call other agents (via SOAT tools), each nested generation creates its own trace. All traces in one chain share the same `root_trace_id`. The `GET /traces/:id/tree` endpoint returns the entire tree — the root node with all its descendants nested under `children` — from any trace ID in the chain.

### Step Serialization

Each trace stores the raw step objects produced by the Vercel AI SDK `generateText` call. `Error` instances are serialized to plain objects with `message`, `name`, and any enumerable properties so that errors (e.g. HTTP tool failures) are preserved faithfully in the JSON file.

### File Linkage

Trace content (the step array) is stored as a file at the path `/traces/{traceId}.json` inside the project's file storage. The `file_id` field on the trace record points to this file so it can be downloaded directly via the Files API.

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
trc_A   (root)
└── trc_B   (child of A)
    └── trc_C   (child of B)
```

The three trace records look like this:

```json
[
  {
    "id": "trc_A",
    "agent_id": "agt_orchestrator",
    "parent_trace_id": null,
    "root_trace_id": null,
    "step_count": 3,
    "created_at": "2025-01-15T10:30:00Z"
  },
  {
    "id": "trc_B",
    "agent_id": "agt_researcher",
    "parent_trace_id": "trc_A",
    "root_trace_id": "trc_A",
    "step_count": 5,
    "created_at": "2025-01-15T10:30:02Z"
  },
  {
    "id": "trc_C",
    "agent_id": "agt_summarizer",
    "parent_trace_id": "trc_B",
    "root_trace_id": "trc_A",
    "step_count": 2,
    "created_at": "2025-01-15T10:30:08Z"
  }
]
```

Key observations:
- `trc_A` is the root: both `parent_trace_id` and `root_trace_id` are `null`.
- `trc_B` is a depth-1 child: `parent_trace_id === root_trace_id === "trc_A"`.
- `trc_C` is a depth-2 child: `parent_trace_id` points to its immediate parent (`trc_B`), while `root_trace_id` still points to the top-level root (`trc_A`).

### Reconstructing the Tree from API Results

**Option 1 — Use the tree endpoint (recommended)**

Supply any trace ID from the chain. The server resolves the root and returns the fully nested tree in one call:

```
GET /api/v1/traces/{any_trace_id}/tree
```

Response shape:

```json
{
  "id": "trc_A",
  "parent_trace_id": null,
  "root_trace_id": null,
  "children": [
    {
      "id": "trc_B",
      "parent_trace_id": "trc_A",
      "root_trace_id": "trc_A",
      "children": [
        {
          "id": "trc_C",
          "parent_trace_id": "trc_B",
          "root_trace_id": "trc_A",
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

<Tabs>
<TabItem value="cli" label="CLI">

List traces for a project:

```bash
soat list-traces --project_id proj_abc123
```

Fetch a single trace:

```bash
soat get-trace --trace-id trc_abc123
```

Fetch the full trace tree (includes nested sub-agent traces):

```bash
soat get-trace-tree --trace-id trc_abc123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { createSoatClient } from '@soat/sdk';

const client = createSoatClient({ apiKey: process.env.SOAT_API_KEY });

// List traces
const { data: traces } = await client.GET('/api/v1/traces', {
  params: { query: { project_id: 'proj_abc123' } },
});

// Get a single trace
const trace = await client.GET('/api/v1/traces/{trace_id}', {
  params: { path: { trace_id: 'trc_abc123' } },
});

// Get the full trace tree
const tree = await client.GET('/api/v1/traces/{trace_id}/tree', {
  params: { path: { trace_id: 'trc_abc123' } },
});
```

</TabItem>
</Tabs>
