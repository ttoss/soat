---
description: "Generation records track individual LLM runs started by agents, including lifecycle status and failure details."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Generations

Generation records track individual LLM generation runs started by agents, including their lifecycle status and any failure details.

## Overview

Every agent generation (`POST /agents/:id/generate`, session generation, sub-agent calls) creates a generation record before the model is called. The record tracks the run through its lifecycle and — when the run fails — stores a structured error payload so failed generations are distinguishable from pending ones and can be debugged post-mortem.

Generations can be listed via `GET /generations` (filter by `agent_id`, `trace_id`, or `status`), and each record can be retrieved via `GET /generations/:generation_id`.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field                       | Type           | Description                                                                                          |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                        | string         | Public identifier for the generation                                                                 |
| `project_id`                | string         | Project the generation belongs to                                                                    |
| `agent_id`                  | string         | Agent that ran the generation                                                                        |
| `trace_id`                  | string         | Trace this generation belongs to                                                                     |
| `initiator_generation_id`   | string \| null | Generation that triggered this one. Set only for sub-agent invocations; `null` for top-level generations |
| `started_by_principal_type` | string \| null | Type of the principal that started the generation                                                    |
| `started_by_principal_id`   | string \| null | ID of the principal that started the generation                                                      |
| `status`                    | string         | Lifecycle status: `in_progress`, `requires_action`, `completed`, or `failed`                         |
| `started_at`                | string         | When the generation started                                                                          |
| `completed_at`              | string \| null | When the generation reached a terminal state                                                         |
| `last_activity_at`          | string \| null | Last activity timestamp                                                                              |
| `stop_reason`               | string \| null | Why the generation stopped (e.g. `stop`, `error`, `depth_guard`)                                     |
| `error`                     | object \| null | Structured error payload recorded when the generation failed (see [Error Recording](#error-recording)) |
| `metadata`                  | object \| null | Non-sensitive structured metadata: caller-supplied key/value pairs plus server-written keys (see [Metadata](#metadata)) |
| `created_at`                | string         | ISO 8601 creation timestamp                                                                          |
| `updated_at`                | string         | ISO 8601 last-update timestamp                                                                       |

## Key Concepts

### Lifecycle

A generation starts as `in_progress`. It transitions to:

- `requires_action` when a client tool call pauses the run and the caller must submit tool outputs.
- `completed` when the model finishes (the `stop_reason` carries the finish reason).
- `failed` when the run errors — for example when the upstream AI provider returns an error or is unreachable. `stop_reason` is set to `error` and the `error` field carries the failure details.

### Error Recording

When a generation fails, the failure is persisted on both the generation record and its trace:

```json
{
  "id": "gen_abc123",
  "status": "failed",
  "stop_reason": "error",
  "error": {
    "code": "AI_PROVIDER_ERROR",
    "message": "Provider returned 402: insufficient credits"
  }
}
```

The `error` object always contains `message`. `code` is set for mapped errors — most notably `AI_PROVIDER_ERROR`, which is used when the upstream AI provider returns an error (e.g. exhausted credits, rate limit) or is unreachable.

### Provider Error Surfacing (`AI_PROVIDER_ERROR`)

Generation endpoints return HTTP `502` with the `AI_PROVIDER_ERROR` code when the upstream AI provider fails:

```json
{
  "error": {
    "code": "AI_PROVIDER_ERROR",
    "message": "Provider returned 402: insufficient credits",
    "meta": {
      "provider_status_code": 402,
      "generation_id": "gen_abc123",
      "trace_id": "trace_xyz789"
    }
  }
}
```

The `meta` field includes the `generation_id` and `trace_id` of the failed run so the failure can be inspected post-mortem via `GET /generations/:generation_id` and `GET /traces/:trace_id`.

### Metadata

The `metadata` field is a JSONB bag that holds both **caller-supplied** key/value pairs and **server-written** keys. It is a place to attach per-run audit attribution — for example, which knowledge-corpus version produced an AI action.

Callers can write metadata two ways:

- **At create time** — pass a `metadata` object on `POST /agents/:id/generate`.
- **After creation** — `PATCH /generations/:generation_id` with a `metadata` object. The provided keys are **shallow-merged** over the existing metadata, so repeated patches accumulate and server-written keys are preserved.

Both paths require the `generations:UpdateGeneration` action for PATCH and `agents:CreateAgentGeneration` for the create path.

Server-owned keys are **reserved** and cannot be set or overwritten by callers — a write that includes any of them is rejected with `400`:

| Reserved key   | Written by                                                        |
| -------------- | ----------------------------------------------------------------- |
| `action_id`    | The logical action label supplied on the generate request          |
| `trigger_id`   | Set when a trigger initiated the generation                        |
| `run_id`       | Orchestration run attribution (usage rollup)                       |
| `node_id`      | Orchestration node attribution (usage rollup)                      |
| `extraction`   | The memory-extraction summary (see below)                          |

Internal recovery state (used to resume a `requires_action` generation after a server restart) is stored under the same DB column but is never exposed through the API.

#### `metadata.extraction` — memory-extraction summary

When an agent is configured with `knowledge_config.extraction` and `write_memory_id`, a completed generation writes a `metadata.extraction` summary describing what the auto-extraction pass did with the turn:

```json
{
  "metadata": {
    "extraction": {
      "candidates": 3,
      "created": 2,
      "updated": 1,
      "skipped": 0
    }
  }
}
```

| Field        | Description                                             |
| ------------ | -------------------------------------------------------- |
| `candidates` | Number of extraction candidates considered from the turn |
| `created`    | Number of new memory entries created                     |
| `updated`    | Number of existing memory entries updated                |
| `skipped`    | Number of candidates skipped (e.g. duplicates)           |

See [Knowledge](./knowledge.md) for how `write_memory_id` and `extraction` are configured on an agent.

### Sub-agent invocations

`initiator_generation_id` is populated only when an agent calls another agent via a SOAT tool: the child generation records the calling generation's ID, while top-level generations leave it `null`. This is the sole case in which the field is set.

Deep reasoning lives in the [Discussions](./discussions.md) module. A discussion run records its deliberation as a Conversation transcript and its outcome as a Document referenced from the run, so it does not appear as `metadata` on, or as a child generation of, the calling generation.

## Examples

### List generations

Filter by `agent_id`, `trace_id`, `initiator_generation_id`, or `status`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-generations --trace-id trace_abc123 --status failed
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.generations.listGenerations({
  query: { trace_id: 'trace_abc123', status: 'failed' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/generations?trace_id=trace_abc123&status=failed" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Get a generation

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-generation --generation-id gen_abc123
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.generations.getGeneration({
  path: { generation_id: 'gen_abc123' },
});
if (error) throw new Error(JSON.stringify(error));
// data.status is "in_progress", "requires_action", "completed", or "failed"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/generations/gen_abc123 \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Attach audit metadata

Merge caller-supplied metadata onto a generation for per-run audit attribution. Reserved server-owned keys are rejected.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-generation --generation-id gen_abc123 \
  --metadata '{"team":"payments","ticket_id":"OPS-4821"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.generations.updateGeneration({
  path: { generation_id: 'gen_abc123' },
  body: { metadata: { team: 'payments', ticket_id: 'OPS-4821' } },
});
if (error) throw new Error(JSON.stringify(error));
// data.metadata.ticket_id === "OPS-4821"
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X PATCH https://api.example.com/api/v1/generations/gen_abc123 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"team":"payments","ticket_id":"OPS-4821"}}'
```

</TabItem>
</Tabs>
