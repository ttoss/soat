import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Traces

Traces record the full execution history of agent generations, including every reasoning step and tool call.

## Overview

Every time an agent runs a generation, SOAT automatically records a trace: the sequence of steps the model took, the tools it invoked, the inputs and outputs at each step, and any errors encountered. Traces are stored as JSON files in the project's file storage and indexed in the database for fast retrieval.

Traces support **parent-child relationships**: when an agent spawns a sub-agent (e.g. via a SOAT tool), the child generation creates its own trace linked back to the parent via `parent_trace_id` and the common `root_trace_id`. This allows the full execution tree to be reconstructed.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field             | Type           | Description                                                                                 |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `id`              | string         | Public identifier for the trace                                                             |
| `project_id`      | string         | Project the trace belongs to                                                                |
| `agent_id`        | string         | Agent that produced the trace                                                               |
| `file_id`         | string \| null | ID of the file containing the serialized steps (JSON array)                                 |
| `step_count`      | number         | Number of reasoning steps recorded                                                          |
| `parent_trace_id` | string \| null | ID of the parent trace when this generation was triggered by another agent                  |
| `root_trace_id`   | string \| null | ID of the root trace in a multi-agent chain; `null` when this trace is itself the root      |
| `created_at`      | string         | ISO 8601 creation timestamp                                                                 |

## Key Concepts

### Trace Tree

When agents call other agents (via SOAT tools), each nested generation creates its own trace. All traces in one chain share the same `root_trace_id`. The `GET /traces/:id/tree` endpoint returns the entire tree — the root node with all its descendants nested under `children` — from any trace ID in the chain.

### Step Serialization

Each trace stores the raw step objects produced by the Vercel AI SDK `generateText` call. `Error` instances are serialized to plain objects with `message`, `name`, and any enumerable properties so that errors (e.g. HTTP tool failures) are preserved faithfully in the JSON file.

### File Linkage

Trace content (the step array) is stored as a file at the path `/traces/{traceId}.json` inside the project's file storage. The `file_id` field on the trace record points to this file so it can be downloaded directly via the Files API.

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
