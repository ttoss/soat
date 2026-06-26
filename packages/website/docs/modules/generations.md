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
| `initiator_generation_id`   | string \| null | Generation that triggered this one. Set for pipeline step children and sub-agent invocations alike; `null` for top-level generations |
| `started_by_principal_type` | string \| null | Type of the principal that started the generation                                                    |
| `started_by_principal_id`   | string \| null | ID of the principal that started the generation                                                      |
| `status`                    | string         | Lifecycle status: `in_progress`, `requires_action`, `completed`, or `failed`                         |
| `started_at`                | string         | When the generation started                                                                          |
| `completed_at`              | string \| null | When the generation reached a terminal state                                                         |
| `last_activity_at`          | string \| null | Last activity timestamp                                                                              |
| `stop_reason`               | string \| null | Why the generation stopped (e.g. `stop`, `error`, `depth_guard`)                                     |
| `error`                     | object \| null | Structured error payload recorded when the generation failed (see [Error Recording](#error-recording)) |
| `metadata`                  | object \| null | Structured metadata written by reasoning modes (see [Metadata](#metadata))                           |
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

The `metadata` field is written by the server to record the outcome of reasoning modes. It is read-only and not settable by callers.

#### `metadata.reasoning` — pipeline summary

The [`pipeline` reasoning mode](./agents.md#reasoning-deep-thinking) writes a `metadata.reasoning` object on the parent generation once the pipeline completes:

```json
{
  "metadata": {
    "reasoning": {
      "mode": "pipeline",
      "applied": true,
      "reason": "completed",
      "stepsRun": 3,
      "dropped": 0,
      "fallback": false
    }
  }
}
```

| Field | Values | Description |
|-------|--------|-------------|
| `mode` | `pipeline` | The orchestrated reasoning mode that ran |
| `applied` | boolean | `true` if the pipeline's final answer replaced the draft |
| `reason` | `completed` \| `halted` \| `all_failed` \| `output_failed` | Why `applied` is true or false |
| `stepsRun` | number | Number of step (and fanout) completions that produced output |
| `dropped` | number | Number of step/perspective turns that failed and were dropped |
| `fallback` | boolean | `true` when the engine silently degraded to the plain draft (also emits an [`agents.reasoning.fallback`](./webhooks.md) event) |

`stepsRun`, `dropped`, and `fallback` make the cost and health of a pipeline measurable: a high `dropped` count or `fallback: true` means the deep-thinking pass under-delivered and the answer is closer to (or exactly) the plain draft. `reason: halted` means a step's `halt_if_equals` short-circuit fired and the draft was kept deliberately.

#### `metadata.reasoning` on pipeline child generations

Each pipeline step (and each fanout perspective turn) creates a **child generation** linked to the parent via `initiator_generation_id`. These child records carry their own `metadata.reasoning`:

```json
{
  "metadata": {
    "reasoning": {
      "step": "critique",
      "output": "The draft overstates the second claim because..."
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `step` | The step `name` (e.g. `"critique"`, `"final"`) or, for a fanout step, the perspective name (e.g. `"Skeptic"`) |
| `round` | Zero-based round index. Present on fanout perspective turns only. Useful when `rounds > 1` to distinguish the same persona's first and second contributions |
| `output` | The text produced by this step |

:::info Pipeline steps vs sub-agent traces

Pipeline steps are **not** sub-traces — they live in the **same trace** as the parent generation. `GET /traces/:id/tree` only shows sub-agent hierarchy (child traces); pipeline steps will not appear there as children.

To retrieve pipeline steps for a parent generation, use either:

- `GET /generations?trace_id=X&initiator_generation_id=<parent_gen_id>` — returns only the pipeline children of that specific generation.
- `GET /traces/:id/tree?include=generations` — returns the full trace tree with all generations (including pipeline children) embedded on each node.

:::

Child records with `status: "failed"` indicate a step that errored; the parent generation is unaffected.
