# PRD: Model Routing & Fallback Module

> Complements [prd-orchestration-queue.md](./prd-orchestration-queue.md) and
> the [Triggers module](../packages/website/docs/modules/triggers.md): unattended
> runs need completions that
> survive a provider outage. Pricing is unaffected — see
> [prd-usage-metering.md](./prd-usage-metering.md).

## Implementation Status

| Component                                        | Status         | Notes                                                            |
| ------------------------------------------------ | -------------- | ---------------------------------------------------------------- |
| `ModelRoute` model + lib                         | ❌ Not started | `route_` prefix, ordered targets + retry/breaker config          |
| REST CRUD + OpenAPI + permissions                | ❌ Not started | MCP tools derive automatically from the OpenAPI spec             |
| Shared exclusivity validation (`route` vs pin)   | ❌ Not started | Exported from `src/lib/modelRoutes.ts`, reused by REST + formations |
| Agent consumption (`model_route_id`)             | ❌ Not started | Alternative to `ai_provider_id` + `model`                        |
| Ordered fallback executor (non-streaming)        | ❌ Not started | Wraps `resolveCompletionModel` / `buildModel`                    |
| Circuit breaker (in-process)                     | ❌ Not started | Per-target consecutive-failure skip with cooldown                |
| Streaming pre-token fallback                     | ❌ Not started | Fallback only before the first token                             |
| `routing` metadata on Generation                 | ❌ Not started | Route id, target index served, attempts, fallbacks               |
| Remaining consumers (discussions, extraction, chats) | ❌ Not started | Everywhere `resolveCompletionModel` is called today          |
| `model-route` formation resource type            | ❌ Not started | `modelRoutesFormationModule.ts` + `ModelRouteResourceProperties` |

## Problem

Today a completion model is resolved through a strictly single-provider path.
`resolveCompletionModel` (`packages/server/src/lib/completionModel.ts`) loads
the agent, picks exactly one provider — the agent's pinned `aiProvider`, or an
explicit same-project `aiProviderId` override — resolves its secret via
`resolveAiProviderSecret` (`src/lib/aiProviders.ts`), picks one model name
(explicit `model` → agent's `model` → provider `default_model`), and calls
`buildModel` (`src/lib/agentModel.ts`) to construct a single `LanguageModel`
for one of the 10 provider slugs (`openai`, `anthropic`, `google`, `xai`,
`groq`, `ollama`, `azure`, `bedrock`, `gateway`, `custom` —
`packages/postgresdb/src/models/AiProvider.ts`).

`ai-providers` is a registry, not a router. Every agent pins one
`ai_provider_id` + `model`, so a single provider outage or sustained 429 stalls
every agent, session, discussion, and orchestration run referencing it — there
is no failover, no routing by task profile, and no provider health signal. With
schedules and the durable orchestration queue running work unattended, nobody
is watching to retry by hand: this is an **availability** gap, not a
convenience gap.

## Goals

- Project-scoped `ModelRoute` resource: a named, ordered list of
  provider+model targets with retry and circuit-breaker configuration.
- `model_route_id` accepted everywhere `ai_provider_id` + `model` is accepted
  today (agents first; then discussions, memory extraction, chats).
- Deterministic runtime semantics: ordered priority, retry only on retryable
  failures, fail fast on deterministic rejections.
- Full observability: the serving target is recorded on the Generation.
- Backward compatible and opt-in: existing pinned fields keep working
  unchanged.

## Non-Goals

- **No cost-optimizing auto-routing / bandit selection.** v1 is explicit
  ordered priority. A future `strategy` field could add latency/cost-aware
  selection on top of the same target list.
- **No cross-project routes.** Targets must reference providers in the route's
  project, mirroring the existing `resolveCompletionModel` override guard.
- **No load-balancing weights.** Ordered priority only in v1.
- **No durable provider health store** — see the circuit-breaker decision.

## Key Concepts

### Route Resolution and Mutual Exclusivity

A consumer sets **either** `model_route_id` **or** `ai_provider_id` + `model`
— never both. The rule is a pure function exported from
`src/lib/modelRoutes.ts` (per the shared-business-rules pattern in
`.claude/rules/modules.md`) and reused by REST handlers and the formation
module:

```ts
export const validateModelRouteExclusivity = (args: {
  modelRouteId: unknown;
  aiProviderId: unknown;
  model: unknown;
}): string | null => { ... };
```

Routes are strictly opt-in: an agent without `model_route_id` resolves exactly
as today.

### Fallback Semantics

Targets are tried in array order. A target failing with a **retryable** error
— membership of the route's `retry_on` list: `provider_error` (5xx/connection),
`timeout`, `rate_limited` (429) — is retried up to its `max_retries`, then the
executor falls through to the next target. **Non-retryable** errors (400-class
provider responses, auth failures, content-policy rejections) do **not** fall
through; the generation fails immediately.

**Decision:** deterministic rejections never fail over. A malformed request or
policy rejection will fail identically on every target — retrying it wastes
spend, adds latency, and hides the caller's bug behind a different provider's
error message. Only infrastructure-shaped failures justify failover.

### Circuit Breaker

After `failure_threshold` consecutive retryable failures, a target is skipped
for `cooldown_seconds`, then probed again.

**Decision:** breaker state lives in **in-process memory per node**, not in
the database. Provider health is a hot-path hint with a half-life of seconds —
persisting it would put a write on every completion and a read before every
target attempt for a fact that is stale by the time it commits. A cold node
re-learns an outage within `failure_threshold` requests; the cost of that
re-learning is far lower than the cost of a durable health table. Multi-node
deployments may briefly disagree about a target's health; that is acceptable.

### Streaming

Fallback applies **before the first token only**. Once a stream has started,
a mid-response failure surfaces as an error to the caller.

**Decision:** replaying a partial stream on another provider would re-execute
tool calls (duplicating side effects), re-bill the prefix tokens, and splice
two models' outputs into one message. Pre-token failures are indistinguishable
from non-streaming failures and fail over safely.

### Observability and Metering

The Generation record already stores the served model; the executor adds a
`routing` object to the Generation `metadata` (JSONB, already present on the
model): `{ route_id, target_index, attempts: [{ target_index, ai_provider_id,
model, error_class? }], fallbacks }`. Traces therefore explain which provider
actually answered.

Usage metering ([prd-usage-metering.md](./prd-usage-metering.md)) prices the
generation off the served provider/model — since that is what the record
stores, **no metering change is needed**; noted here for completeness.

## Data Model

### ModelRoute

| Field               | Type            | Description                                                          |
| ------------------- | --------------- | -------------------------------------------------------------------- |
| `id`                | string          | Public ID (`route_` prefix — no collision in `packages/postgresdb/src/utils/publicId.ts`) |
| `project_id`        | string          | Owning project                                                       |
| `name`              | string          | Human-readable name, unique per project                              |
| `targets`           | array           | Ordered; each `{ ai_provider_id, model, timeout_seconds?, max_retries? }` (JSONB; min 1 entry; providers validated against the project) |
| `retry_on`          | string[]        | Subset of `provider_error` \| `timeout` \| `rate_limited` (default: all three) |
| `failure_threshold` | integer         | Consecutive retryable failures before a target is skipped (default 3) |
| `cooldown_seconds`  | integer         | How long a tripped target is skipped (default 60)                    |
| `created_at`        | string          |                                                                       |
| `updated_at`        | string          |                                                                       |

Indexes: `(project_id)`, unique `(publicId)`, unique `(project_id, name)`.

Consumers gain a nullable `model_route_id` column (Agent first; Discussion,
Chat, memory-extraction config in Phase 3), mutually exclusive with the
existing pinned fields.

## Permissions

| Permission                      | Endpoint                                    |
| ------------------------------- | ------------------------------------------- |
| `model-routes:CreateModelRoute` | `POST /api/v1/model-routes`                 |
| `model-routes:ListModelRoutes`  | `GET /api/v1/model-routes`                  |
| `model-routes:GetModelRoute`    | `GET /api/v1/model-routes/{route_id}`       |
| `model-routes:UpdateModelRoute` | `PUT /api/v1/model-routes/{route_id}`       |
| `model-routes:DeleteModelRoute` | `DELETE /api/v1/model-routes/{route_id}`    |

## REST API

All body fields snake_case per project convention. SDK, CLI, and MCP tools
(`create-model-route`, …) derive from the OpenAPI spec
(`packages/server/src/rest/openapi/v1/model-routes.yaml`) via the standard
regeneration steps.

| Method | Path                                 | Description                          |
| ------ | ------------------------------------ | ------------------------------------ |
| POST   | `/api/v1/model-routes`               | Create a route                       |
| GET    | `/api/v1/model-routes`               | List routes (filter by project)      |
| GET    | `/api/v1/model-routes/{route_id}`    | Get a route                          |
| PUT    | `/api/v1/model-routes/{route_id}`    | Update name/targets/retry/breaker    |
| DELETE | `/api/v1/model-routes/{route_id}`    | Delete (409 if referenced by a consumer) |

## Implementation Phases

### Phase 1 — CRUD, Agent Consumption, Ordered Fallback (non-streaming) ❌ Not started

**Deliverables:** `ModelRoute` model + `src/lib/modelRoutes.ts`; REST CRUD +
OpenAPI + permissions + SDK/CLI regeneration + module docs; shared exclusivity
validator; `model_route_id` on agents; fallback executor wrapping
`resolveCompletionModel` for non-streaming generations.

**Acceptance criteria:**

- CRUD happy path, 401, 403, cross-project 404 covered in
  `tests/unit/tests/rest/model-routes.test.ts`.
- Creating a route whose target references another project's provider returns 400.
- Setting both `model_route_id` and `ai_provider_id` on an agent returns 400
  from REST **and** produces a validation error from the formation module,
  via the same exported function.
- With a route `[failing-provider, healthy-provider]` — driven by two local
  fake OpenAI-compatible servers (the `createServer` stub pattern from
  `discussionCompletion.test.ts`), the first returning 500 — a generation
  succeeds and its response records the healthy target's model.
- With the first target failing with a 400-class error, the generation fails
  and the fake second server received **zero** requests.
- An agent without `model_route_id` produces byte-identical resolution
  behavior to today (existing tests stay green).

### Phase 2 — Circuit Breaker, Streaming, Routing Metadata ❌ Not started

**Deliverables:** in-process breaker; pre-first-token fallback for streaming;
`routing` metadata written to Generation.

**Acceptance criteria:**

- After `failure_threshold` consecutive failures of target 0, the next
  generation calls target 1 directly (fake server 0 receives no request);
  after `cooldown_seconds` (fake timers), target 0 is probed again.
- Fallback generation's `GET /generations/{generation_id}` metadata contains
  `routing.target_index === 1`, `routing.fallbacks === 1`, and an `attempts`
  array naming both targets.
- A streaming request whose first target fails before any token succeeds via
  target 1; a fake stream that dies after emitting tokens surfaces an error
  and metadata records no additional attempts.

### Phase 3 — Remaining Consumers + Formation Resource ❌ Not started

**Deliverables:** `model_route_id` accepted by discussions, memory extraction,
and chats (every `resolveCompletionModel` call site); `model-route` formation
resource type (`modelRoutesFormationModule.ts`, `ModelRouteResourceProperties`
in `formations.yaml`); smoke-test steps via `$SOAT_CLI`.

**Acceptance criteria:**

- A discussion run and a memory-extraction completion configured with a route
  whose first target fails complete successfully via the second target.
- A formation template declaring a `model-route` resource plans, applies, and
  reads back `targets` in snake_case; unknown fields are rejected with 400.
- Deleting a route referenced by an agent returns 409.

## Risks

- **Retry amplification.** A route with high `max_retries` across many targets
  multiplies latency and spend during a partial outage. Mitigation: cap total
  attempts per generation (targets × retries ≤ a hard server limit) and
  document defaults conservatively.
- **Per-node breaker divergence.** Nodes learn outages independently; a large
  fleet still sends `failure_threshold` requests per node into a dead
  provider. Accepted for v1 (see decision); revisit only with evidence.
- **Model-name portability.** A route target names its model explicitly, so
  the cross-provider "meaningless model name" hazard that
  `resolveCompletionModel` guards against does not apply — but operators can
  still configure a wrong model per target; creation-time validation is
  name-format only.
- **Behavioral drift across targets.** Failover changes the answering model
  mid-conversation; quality-sensitive consumers should order same-family
  models. Documented, not enforced.
