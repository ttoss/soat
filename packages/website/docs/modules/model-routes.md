---
description: 'Ordered provider+model failover for SOAT completions: a named route with retry, per-target timeouts, and a circuit breaker, recorded on the generation.'
---

# Model Routes

Project-scoped failover for completion models: a named, ordered list of provider+model targets tried in priority order.

## Overview

An agent normally pins one [AI provider](./ai-providers.md) and one model. A single provider outage or a sustained `429` then stalls every generation that references it — with schedules and the [durable orchestration queue](./orchestrations.md#durable-background-execution) running work unattended, nobody is there to retry by hand.

A model route replaces that pin with an ordered list of targets. The first target is tried first; a **retryable** failure is retried up to that target's `max_retries` and then falls through to the next target. A **deterministic** failure (400-class, auth, content policy) fails immediately — it would fail identically on every target.

Routing is opt-in and byte-identical for anything that does not use it: an agent without `model_route_id` resolves exactly as before.

> This is not a replacement for an external gateway. The `gateway` provider slug still lets you front providers with LiteLLM/OpenRouter. A model route is the SOAT-native alternative: the credentials stay in the [secrets](./secrets.md) module, the config lives inside SOAT's IAM and [formations](./formations.md), and the [generation](./generations.md) records which target actually answered.

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

### Route or pin — never both

A consumer sets **either** `model_route_id` **or** `ai_provider_id` (+ `model`). Setting both, or neither, is a `400`. `model` cannot accompany a route: each target names its own model.

The invariant is enforced on every write path — REST, and [formations](./formations.md) — by one exported validator, so `ai_provider_id` never lingers as dead config next to a route that overrides it.

To switch a pinned agent to a route, clear the pin in the same request:

```bash
soat update-agent --agent_id agent_… --model_route_id route_… --ai_provider_id null
```

### The routing layer is a composite model

A route resolves to a **composite language model** holding one inner model per target. The failover happens around the *individual LLM call*, not around the whole generation.

That distinction is the point. Agent generation is a multi-step loop whose tools have real side effects (HTTP, MCP, SOAT actions, `write_memory`). Retrying the *generation* on another provider would re-execute every tool call that already succeeded. Failing over one call keeps steps 1…n−1's tool results in the message history — a provider failure on the step-5 LLM call is invisible to the tools.

### Retry ownership

The route config is the **only** retry authority. The AI SDK's own `maxRetries` (default `2`) is set to `0` for routed calls, so a route with `max_retries: 2` issues 3 attempts per target — not 9. Non-routed calls keep the SDK default untouched.

The total attempt budget — `Σ (1 + max_retries)` over all targets — is capped at **10** and validated at create/update time, rejecting with a `400` that names the computed total. There is no runtime clamp: silently truncating configured behavior would be worse than refusing to store it.

### Error classification

The class assigned to a failure decides whether it fails over. First match wins:

| Condition                                                                              | Class            | Fails over? |
| -------------------------------------------------------------------------------------- | ---------------- | ----------- |
| Provider returned `429`                                                                | `rate_limited`   | yes         |
| Abort or timeout, including a per-target `timeout_seconds`                              | `timeout`        | yes         |
| Provider returned `5xx`, marked the error retryable, or the connection failed outright  | `provider_error` | yes         |
| Everything else — 400-class, auth, content policy, schema validation                    | *(deterministic)* | no — fails fast |

A class **not listed** in the route's `retry_on` is treated as terminal too: `retry_on` is the failover-eligibility list, not just a retry filter.

A **caller-initiated abort** (the caller's own signal fired) aborts the run and never fails over, even though it looks like a per-target timeout.

### Per-target timeout

`timeout_seconds` is enforced with a per-attempt `AbortSignal` composed with the caller's signal, so both can cancel the attempt — but only the timeout is a failover.

### Circuit breaker

After `failure_threshold` consecutive retryable failures, a target is skipped for `cooldown_seconds` and then probed again.

Breaker state is **in-process per node**, not in the database: provider health is a hot-path hint with a half-life of seconds, and persisting it would add a write to every completion and a read before every attempt for a fact that is stale by the time it commits. A cold node re-learns an outage within `failure_threshold` requests, and nodes may briefly disagree about a target's health.

State is keyed by `(provider, model)` and therefore **shared across routes** — a dead backend is dead regardless of which route noticed. The *counter* is shared; the *policy* (`failure_threshold` / `cooldown_seconds`) belongs to the route evaluating the target, so two routes may legitimately start skipping at different points.

If the breaker would skip *every* target, the first one is probed anyway: refusing to call would turn a transient outage into a hard `cooldown_seconds` outage even after the provider recovered.

### Streaming

Fallback applies **before the first token only**. Once a stream has started, a mid-response failure surfaces to the caller as an error. Replaying a partial stream on another provider would duplicate tool side effects, re-bill the prefix, and splice two models' outputs into one message.

### Observability and metering

The [generation](./generations.md) records the model that actually served it, so [usage metering](./usage.md) prices the completion against the provider that answered — no metering change, and no wrong attribution.

**Known gap:** a *failed* attempt that burned tokens before erroring is not metered. Providers typically return no usage alongside an error, so the data to price it does not exist; the attempt is still visible rather than silent.

### Deleting a route

`DELETE` returns `409 MODEL_ROUTE_HAS_DEPENDENTS` while an agent still references the route — a routed agent has no pinned provider to fall back on, so a dangling reference would break every one of its generations. The error `meta` reports the count and a sample of agent IDs.

## Consumers

| Consumer                          | Accepts `model_route_id` |
| --------------------------------- | ------------------------ |
| Agents (generations, and client-tool resumption) | yes       |
| Chats, discussions, memory extraction/consolidation | not yet — these resolve a single provider, and a route-only agent needs an explicit `ai_provider_id` on the completion config |

## Behavioral drift

Failover changes the answering model mid-conversation and, with per-call failover, potentially mid-*run* between steps of one generation. Order same-family models when output shape matters. This is documented, not enforced.
