---
description: 'Ordered provider+model failover for SOAT completions: a named route with retry, per-target timeouts, and a circuit breaker, recorded on the generation.'
---

# Model Routes

Project-scoped failover for completion models: a named, ordered list of provider+model targets tried in priority order.

## Overview

An agent normally pins one [AI provider](./ai-providers.md) and one model; a provider outage or sustained `429` then stalls every generation referencing it, including unattended schedules and the [durable orchestration queue](./orchestrations.md#durable-background-execution).

A route replaces the pin with an ordered list of targets. A **retryable** failure is retried up to the target's `max_retries`, then falls through to the next target. A **deterministic** failure (400-class, auth, content policy) fails immediately.

Routing is opt-in: a consumer pinning `ai_provider_id` resolves as before. A consumer naming **neither** a route nor a provider inherits the project's [`default_model_route_id`](#project-default-route), which is how chats and memory completions get failover.

> Not a replacement for an external gateway: the `gateway` provider slug still fronts LiteLLM/OpenRouter. A route keeps credentials in [secrets](./secrets.md), config in IAM and [formations](./formations.md), and records the answering target on the [generation](./generations.md).

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field               | Type     | Description                                                                                   |
| ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `id`                | string   | Public identifier (e.g. `route_…`)                                                            |
| `project_id`        | string   | ID of the owning project                                                                      |
| `name`              | string   | Human-readable name, unique per project                                                       |
| `targets`           | array    | Ordered targets — see [Targets](#targets). At least one; total attempts capped at 10           |
| `retry_on`          | string[] | Failover-eligible classes: `provider_error` \| `timeout` \| `rate_limited` (default: all three) |
| `failure_threshold` | integer  | Consecutive retryable failures before a target is skipped (default `3`)                        |
| `cooldown_seconds`  | integer  | How long a tripped target is skipped before being probed again (default `60`)                   |
| `created_at`        | string   | ISO 8601 creation timestamp                                                                    |
| `updated_at`        | string   | ISO 8601 last-updated timestamp                                                                |

### Targets

| Field             | Type    | Description                                                                          |
| ----------------- | ------- | ------------------------------------------------------------------------------------ |
| `ai_provider_id`  | string  | AI provider **in the route's project** (a cross-project target is rejected with `400`) |
| `model`           | string  | Model name to call on that provider                                                   |
| `timeout_seconds` | integer | Optional per-attempt deadline. Omitted means no deadline                              |
| `max_retries`     | integer | Retries on this target before falling through (default `0`)                            |

```bash
soat create-model-route \
  --project_id proj_… \
  --name primary-with-fallback \
  --targets '[
    { "ai_provider_id": "aip_primary",  "model": "gpt-4o-mini", "timeout_seconds": 30, "max_retries": 1 },
    { "ai_provider_id": "aip_fallback", "model": "claude-3-5-haiku-latest" }
  ]'
```

## Key Concepts

### Route or pin — at most one

A consumer sets **at most one** of `model_route_id` and `ai_provider_id` (+ `model`):

| Consumer state         | Resolves through                     |
| ---------------------- | ------------------------------------ |
| `model_route_id` set   | that route                           |
| `ai_provider_id` set   | that provider (+ the consumer's `model`) |
| neither set            | the project's `default_model_route_id` |
| both set               | rejected `400`                       |

An explicit binding always wins; the project default only fills the gap.

`model` cannot accompany a route, named or inherited: each target names its own model.

One exported validator enforces this on every write path (REST and [formations](./formations.md)).

To switch a pinned agent to a route, clear the pin in the same request:

```bash
soat update-agent --agent_id agent_… --model_route_id route_… --ai_provider_id null
```

### Project default route

`default_model_route_id` is inherited by every consumer in the project that binds nothing, turning failover on project-wide without editing each consumer:

```bash
soat update-project --project-id proj_… --default_model_route_id route_…
```

Repointing it to another route is free and changes behavior for every inheriting consumer. Unlike fallbacks on the AI provider, it is a single project-scoped switch, not a side effect of editing a credential, and it cannot override an explicit binding.

Two write-time guards keep "no model at all" unrepresentable:

1. Creating or updating a consumer that binds **neither** field returns `400 VALIDATION_FAILED` unless the project has a `default_model_route_id`.
2. **Clearing** `default_model_route_id` returns `409 PROJECT_DEFAULT_ROUTE_INHERITED` while any consumer inherits it, naming the count and a sample. Bind those consumers explicitly first, or repoint the default instead.

The route must belong to the project (`400`). The field is on the project update surface, governed by `projects:UpdateProject`.

### The routing layer is a composite model

A route resolves to a **composite language model**, one inner model per target; failover wraps the *individual LLM call*, not the whole generation.

Agent generation is a multi-step loop whose tools have side effects (HTTP, MCP, SOAT actions, `write_memory`). Retrying the whole generation would re-execute succeeded tool calls; failing over one call keeps steps 1…n−1 in the message history.

### Retry ownership

The route is the **only** retry authority: the AI SDK's `maxRetries` (default `2`) is `0` for routed calls, so `max_retries: 2` means 3 attempts per target, not 9. Non-routed calls keep the SDK default.

The total budget, `Σ (1 + max_retries)` over all targets, is capped at **10**, validated at create/update with a `400` naming the computed total. There is no runtime clamp.

### Error classification

The class assigned to a failure decides whether it fails over. First match wins:

| Condition                                                                              | Class            | Fails over? |
| -------------------------------------------------------------------------------------- | ---------------- | ----------- |
| Provider returned `429`                                                                | `rate_limited`   | yes         |
| Abort or timeout, including a per-target `timeout_seconds`                              | `timeout`        | yes         |
| Provider returned `5xx`, marked the error retryable, or the connection failed outright  | `provider_error` | yes         |
| Everything else — 400-class, auth, content policy, schema validation                    | *(deterministic)* | no — fails fast |

A class **not listed** in `retry_on` is terminal: `retry_on` is the failover-eligibility list.

A **caller-initiated abort** aborts the run and never fails over.

### Per-target timeout

`timeout_seconds` is a per-attempt `AbortSignal` composed with the caller's signal; only the timeout is a failover.

### Circuit breaker

After `failure_threshold` consecutive retryable failures, a target is skipped for `cooldown_seconds` and then probed again.

Breaker state is **in-process per node**, not persisted (provider health is a hot-path hint stale within seconds). A cold node re-learns an outage within `failure_threshold` requests; nodes may briefly disagree.

State is keyed by `(provider, model)` and **shared across routes**; the *policy* (`failure_threshold` / `cooldown_seconds`) belongs to the evaluating route, so two routes may start skipping at different points.

If the breaker would skip *every* target, the first is probed anyway, so a transient outage does not become a hard `cooldown_seconds` outage.

### Streaming

Fallback applies **before the first token only**; a mid-stream failure surfaces as an error. Replaying a partial stream would duplicate tool side effects, re-bill the prefix, and splice two models' outputs.

### Observability and metering

The [generation](./generations.md) records the serving model, so [usage metering](./usage.md) prices against the provider that answered.

Every routed call writes a `routing` object onto the generation:

```json
{
  "routing": {
    "route_id": "route_…",
    "target_index": 1,
    "fallbacks": 1,
    "attempts": [
      { "target_index": 0, "ai_provider_id": "aip_primary", "model": "gpt-4o-mini", "error_class": "provider_error" },
      { "target_index": 1, "ai_provider_id": "aip_fallback", "model": "claude-3-5-haiku-latest" }
    ]
  }
}
```

`target_index` is the serving target, `fallbacks` how many were exhausted before it; each `attempts` entry carries its [`error_class`](#error-classification), absent on the successful one. `routing` is server-owned, not a `metadata` key.

Internal completions (chats, memory extraction/consolidation) resolve metering attribution *before* the call, so they read the served target back from the routing record afterwards; a routed chat turn is metered on the answering `(ai_provider_id, model)`, never on the route.

**Known gap:** a *failed* attempt that burned tokens is not metered; providers return no usage alongside an error. The attempt is still visible.

### Deleting a route

`DELETE` returns `409 MODEL_ROUTE_HAS_DEPENDENTS` while an agent references the route or it is a project's `default_model_route_id`; `meta` reports both counts and a sample of referencing IDs.

## Consumers

| Consumer                                            | How it routes |
| --------------------------------------------------- | ------------- |
| Agents (generations, and client-tool resumption)    | its own `model_route_id`, else its pin, else the project default |
| Memory extraction / consolidation                   | the completion config's `ai_provider_id` override, else the agent's pin, else the agent's `model_route_id`, else the project default |
| Chats (chat-scoped completions)                     | the chat's pin, else the project default |
| Stateless [`POST /chat/completions`](/docs/api/chats/create-chat-completion)                  | its per-request `ai_provider_id` only — it belongs to no project of its own, so there is no default to inherit |

Chats have **no** `model_route_id` column; a project default plus explicit pins covers the cases. A per-consumer column would only serve *two routes in one project*.

## Behavioral drift

Failover changes the answering model mid-conversation and, per call, mid-*run*. Order same-family models when output shape matters. Documented, not enforced.
