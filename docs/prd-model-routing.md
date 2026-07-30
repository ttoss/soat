# PRD: Model Routing & Fallback Module

> Complements the [durable orchestration queue](../packages/website/docs/modules/orchestrations.md#durable-background-execution) and
> the [Triggers module](../packages/website/docs/modules/triggers.md): unattended
> runs need completions that
> survive a provider outage. Pricing is unaffected — see the
> [usage module doc](../packages/website/docs/modules/usage.md).

## Problem

Today a completion model is resolved through strictly single-provider paths.
Five call sites resolve a provider + secret + model name and construct exactly
one `LanguageModel` via the shared constructor `buildModel`
(`packages/server/src/lib/agentModel.ts`):

| Consumer | Resolution site |
| --- | --- |
| Agent generations | `agentGenerationContext.ts` (`resolveGenerationModel`) |
| Client-tool-output resumption | `agentGenerationRecovery.ts` (`buildPendingFromState`) |
| Discussions | `discussionCompletion.ts` |
| Chats | `chatCompletionModel.ts` |
| Memory extraction / consolidation | `completionModel.ts` (`resolveCompletionModel`) |

> Note: `resolveCompletionModel` serves **only** the memory paths — agents,
> discussions, and chats never call it. An earlier revision of this PRD placed
> the fallback executor there, which would have shipped failover to zero agent
> traffic. The shared seam is `buildModel`, and the phases below are drawn
> around the real call sites.

Every consumer pins one provider instance + model, so a single provider outage
or sustained 429 stalls every agent, session, discussion, and orchestration run
referencing it — there is no failover, no routing by task profile, and no
provider health signal. With schedules and the durable orchestration queue
running work unattended, nobody is watching to retry by hand: this is an
**availability** gap, not a convenience gap.

## Goals

- Project-scoped `ModelRoute` resource: a named, ordered list of
  provider+model targets with retry and circuit-breaker configuration.
- `model_route_id` accepted everywhere `ai_provider_id` + `model` is accepted
  today (agents first; then discussions, chats, memory completions).
- Deterministic runtime semantics: ordered priority, retry only on retryable
  failures, fail fast on deterministic rejections.
- Failover must never re-execute tool calls: a mid-run provider failure fails
  over the **LLM call**, not the whole multi-step run.
- Full observability: the serving target is recorded on the Generation.
- Backward compatible and opt-in: existing pinned fields keep working
  unchanged, byte-identical resolution for agents without a route.

## Non-Goals

- **No cost-optimizing auto-routing / bandit selection.** v1 is explicit
  ordered priority. A future `strategy` field could add latency/cost-aware
  selection on top of the same target list.
- **No cross-project routes.** Targets must reference providers in the route's
  project, mirroring the existing `resolveCompletionModel` override guard.
- **No load-balancing weights.** Ordered priority only in v1.
- **No durable provider health store** — see the circuit-breaker decision.
- **Not a replacement for an external gateway.** The `gateway` provider slug
  already lets an operator front providers with an external router (LiteLLM,
  OpenRouter, …) and get failover outside SOAT. This module exists for
  SOAT-native routing with per-target observability stamped on the
  Generation; the product owner confirmed on 2026-07-30 that this
  distinction justifies the module (all three phases) — see the
  [resolved forwarded questions](#forwarded-questions-resolved-2026-07-30).

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

> **Amended 2026-07-30.** "Exactly one" is relaxed to "**at most** one" so a
> consumer that names neither can inherit its project's default route. The
> exclusivity function is unchanged for consumers that do name one; see
> [Project Default Route](#amendment--project-default-route-2026-07-30).

**Decision (2026-07): strict exclusivity, which requires relaxing
`Agent.aiProviderId` to nullable.** The column is `allowNull: false` today
(`packages/postgresdb/src/models/Agent.ts`), so a route-only agent cannot
exist without a schema change. The alternative — keep the pin required and
let the route override it at resolution time — avoids the migration but
leaves a permanently-displayed `ai_provider_id` that is dead config, with the
precedence rule living in prose. Exclusivity puts the invariant in the schema
plus one validator, and the migration cost is compiler-enumerated: flipping
the `TypedAgent.aiProvider` type to nullable makes `pnpm typecheck` name
every site that assumes a pinned provider (`agentGenerationContext.ts`,
`agentGenerationRecovery.ts`, `completionModel.ts`, the agent mapper). Those
sites are exactly the ones Phase 1/3 must touch anyway.

### Routing Layer: a Composite LanguageModel (decision)

Failover is implemented as a **composite `LanguageModel`** — an object
implementing the same `doGenerate` / `doStream` specification interface as
its targets, holding N inner models built by `buildModel` (one per target)
and delegating with fallback. It is returned from a new
`buildRoutedModel({ route, projectId })` in `src/lib/modelRoutes.ts`; callers
keep receiving a `LanguageModel` and are otherwise untouched.

**Why not wrap the `generateText` call:** agent generation is multi-step —
`generateText({ stopWhen: isStepCount(maxSteps ?? 20) })`
(`agentNonStreamGeneration.ts`) with tools that have real side effects (HTTP,
MCP, SOAT actions, `write_memory`). Call-level failover restarts the whole
loop, re-executing every already-completed tool call. The composite fails
over the **individual LLM call inside the step loop**: a provider failure at
step 5 retries/falls through for that call only, with steps 1–4's tool
results preserved in the message history. This also collapses the seam count
(all five resolution sites end at `buildModel`, so one construct serves every
phase) and makes Phase 2 streaming fallback the same object's `doStream` arm
rather than new machinery.

Checked against the pinned `ai@7.0.26` / `@ai-sdk/provider@4.0.3`:
`LanguageModelV4` is a plain interface (`doGenerate` / `doStream`), and
`wrapLanguageModel` + `LanguageModelMiddleware` (`wrapGenerate` /
`wrapStream` hooks) exist if the middleware form proves more convenient than
a hand-rolled class. Either satisfies the design; the choice between them is
an implementation detail.

### Retry Ownership (decision)

The route config is the **only** retry authority. `generateText` /
`streamText` have their own `maxRetries` (default **2** — verified in the
pinned SDK's types), applied per LLM call *above* the model. Left at its
default, a route with `max_retries: 2` would issue up to 3 × 3 = 9 attempts
per target — silent retry amplification in the exact scenario (an outage)
the caps exist for. Routed calls therefore pass `maxRetries: 0`, letting the
composite own every attempt. Non-routed calls are untouched and keep the SDK
default.

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

### Error Classification (approved 2026-07-30 — public contract)

The mapping from an AI SDK error to a `retry_on` class is public contract
surface: it defines what `retry_on` values mean and is caller-visible in
Phase 2 as `routing.attempts[].error_class`. **Signed off by the product
owner on 2026-07-30** (see the decision log); Phase 1 may freeze it into the
OpenAPI spec, SDK, and CLI. The mapping, checked against
`@ai-sdk/provider@4.0.3` (`APICallError` exposes `statusCode?: number` and
`isRetryable: boolean`) and consistent with the boundary the existing
`src/lib/providerError.ts` (`toProviderDomainError`) already draws between
provider-shaped and caller-shaped failures:

| Condition (first match wins) | Class | Fails over? |
| --- | --- | --- |
| `APICallError` with `statusCode === 429` | `rate_limited` | yes |
| Abort/timeout (`AbortError` / `TimeoutError`, incl. the per-target timeout) — but a caller-initiated abort (the caller's own signal fired) aborts the run, never fails over | `timeout` | yes |
| `APICallError` with `statusCode >= 500`, or `isRetryable === true`, or connection-level failure (no `statusCode`) | `provider_error` | yes |
| Everything else (400-class, auth, content policy, schema validation) | *(deterministic)* | no — fail fast |

### Per-Target Timeout

`timeout_seconds` on a target is enforced with a per-attempt `AbortSignal`
(`AbortSignal.timeout`) composed with the caller's signal — the generation
paths already thread `abortSignal` end-to-end
(`agentGenerationContext` → `agentNonStreamGeneration`), so the composite
combines both per attempt. A per-target timeout classifies as `timeout`; the
caller's own signal firing aborts the run without fallback.

### Attempt Cap (decision)

Retry amplification is bounded at **write time**, not clamped at runtime:
`Σ over targets (1 + max_retries) ≤ 10` is validated on create/update and
rejected `400` naming the computed total. A runtime clamp would silently
truncate configured behavior; a create-time rejection is deterministic
enforcement the operator sees immediately.

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

**Decision (2026-07): the breaker is keyed by `(ai_provider_db_id, model)`,
shared across routes** — not per `(route, target_index)`. A dead provider is
dead regardless of which route noticed; per-route keying makes every route
referencing the same backend independently pay `failure_threshold` failed
requests to learn the same fact. The shared key leaks no state across routes
beyond "is this backend healthy," which is precisely the signal the breaker
exists to share. Threshold/cooldown values still come from the route
evaluating the target, so two routes may hold different opinions about when
to skip — the *counter* is shared, the *policy* is per-route.

### Streaming

Fallback applies **before the first token only**. Once a stream has started,
a mid-response failure surfaces as an error to the caller.

**Decision:** replaying a partial stream on another provider would re-execute
tool calls (duplicating side effects), re-bill the prefix tokens, and splice
two models' outputs into one message. Pre-token failures are indistinguishable
from non-streaming failures and fail over safely. In the composite model this
is the `doStream` arm failing over on a rejection before the stream is
returned/first chunk arrives — the same seam as `doGenerate`, which is why it
ships in Phase 2 as test surface rather than new architecture.

### Observability and Metering

The Generation record already stores the served model; the executor adds a
`routing` object to the Generation `metadata` (JSONB, already present on the
model): `{ route_id, target_index, attempts: [{ target_index, ai_provider_id,
model, error_class? }], fallbacks }`. Traces therefore explain which provider
actually answered.

Usage metering ([usage module doc](../packages/website/docs/modules/usage.md)) prices the
generation off the served provider/model — since that is what the record
stores, **no metering change is needed** for the served attempt.

**Accepted gap (decision):** a *failed* attempt that burned tokens before
erroring (rare for non-streaming; providers typically return no usage with an
error) is not metered. The gap is visible rather than silent — Phase 2's
`routing.attempts` names every failed attempt on the generation — and closing
it would require usage data the error responses do not carry.

## Data Model

### ModelRoute

| Field               | Type            | Description                                                          |
| ------------------- | --------------- | -------------------------------------------------------------------- |
| `id`                | string          | Public ID (`route_` prefix — no collision in `packages/postgresdb/src/utils/publicId.ts`) |
| `project_id`        | string          | Owning project                                                       |
| `name`              | string          | Human-readable name, unique per project                              |
| `targets`           | array           | Ordered; each `{ ai_provider_id, model, timeout_seconds?, max_retries? }` (JSONB; min 1 entry; providers validated against the project; total attempts capped — see [Attempt Cap](#attempt-cap-decision)) |
| `retry_on`          | string[]        | Subset of `provider_error` \| `timeout` \| `rate_limited` (default: all three) |
| `failure_threshold` | integer         | Consecutive retryable failures before a target is skipped (default 3) |
| `cooldown_seconds`  | integer         | How long a tripped target is skipped (default 60)                    |
| `created_at`        | string          |                                                                       |
| `updated_at`        | string          |                                                                       |

Indexes: `(project_id)`, unique `(publicId)`, unique `(project_id, name)`.

### Consumer columns

Consumers gain a nullable `model_route_id` column (Agent first; Discussion,
Chat, memory-extraction config in Phase 3), mutually exclusive with the
existing pinned fields. On **Agent** this additionally relaxes
`aiProviderId` to nullable (see the exclusivity decision above): the
invariant becomes "exactly one of `aiProviderId` / `modelRouteId` is set,"
enforced by the shared validator on every write path, and the
`TypedAgent.aiProvider` type flips to nullable so the compiler enumerates
every consuming site.

**Amended 2026-07-30:** the invariant is now "*at most* one of `aiProviderId` /
`modelRouteId`", with "neither" meaning *inherit the project default route*, and
`Project.defaultModelRouteId` added. Two write-time guards keep "this consumer
has no model at all" unrepresentable — see
[Project Default Route](#amendment--project-default-route-2026-07-30).

### Project

| Field                   | Type          | Description                                                                 |
| ----------------------- | ------------- | --------------------------------------------------------------------------- |
| `default_model_route_id` | string \| null | Route inherited by consumers in this project that name neither a route nor a provider. Null = no default (every consumer must then bind explicitly). Added by the 2026-07-30 amendment |

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
| DELETE | `/api/v1/model-routes/{route_id}`    | Delete — `409` if referenced by a consumer (Phase 1: agents reference routes from day one, so referential protection ships with them) or, after the 2026-07-30 amendment, if it is a project's `default_model_route_id` |

## Amendment — Project Default Route (2026-07-30)

Raised after Phases 1–2 landed: *should the target list live on the AI provider
instead, so every consumer inherits failover automatically?* The appeal is real —
it would delete the nullable `Agent.aiProviderId`, the exclusivity rule, and most
of Phase 3's per-consumer wiring.

**Rejected.** Three costs, one of them fatal in this codebase:

- **The model does not live on the provider.** `Agent`, `Chat`, and `Discussion`
  each carry their own nullable `model` that overrides the provider's
  `default_model`, and a target is inherently a *(provider, model)* pair. With
  fallbacks on the provider, the primary model is per-consumer but the fallback
  models are per-provider: an agent pinned to `gpt-4o` and a chat pinned to
  `gpt-4o-mini` on the same credential cannot share one correct fallback list —
  the cheap consumer silently fails over to the expensive model, and
  "order same-family models" becomes unstatable. Any fix ends in per-consumer
  fallback overrides, i.e. the per-consumer field again, weaker.
- **Inheritance-by-credential is an unbounded blast radius.** Editing a
  credential row would change behavior for every agent, chat, discussion,
  memory extraction, and evaluation referencing it — including consumers whose
  owner never asked for failover (quality-sensitive output shapes, or a
  data-residency constraint pinning one Bedrock region). Adding a per-consumer
  `disable_fallback` to fix that pays the per-consumer cost anyway.
- **The attempt cap stops being enforceable at write time.** Today
  `Σ (1 + max_retries) ≤ 10` is a pure function of one route's own `targets`.
  Provider-level fallbacks form a graph (P→Q→R→P), so the budget depends on rows
  the author is not editing — requiring cycle detection and a runtime depth cap,
  the clamp the [attempt-cap decision](#attempt-cap-decision) refused.

There is also an attribution smell: `PriceBook` and `UsageEvent` are keyed by
`(ai_provider_id, model)`, so a provider row that sometimes answers as a
*different* provider recreates the gateway-alias mis-attribution this module
exists to avoid. `AiProvider` holds `secretId` / slug / `baseUrl` / `config` — it
is a credential and endpoint, not a routing policy.

**Adopted instead: a project-level default route.** Routes are *already* the
shared object — every consumer pointing at one `route_` id inherits changes to
its targets. What was missing is a **default binding** so an operator does not
have to touch each consumer.

### Revised invariant

A consumer sets **at most one** of `model_route_id` / `ai_provider_id`:

| Consumer state | Resolves through |
| --- | --- |
| `model_route_id` set | that route |
| `ai_provider_id` set | that provider (+ the consumer's `model`) |
| neither set | the project's `default_model_route_id` |
| both set | rejected `400` (unchanged) |

`model` still may not accompany a route — named **or inherited** — because each
target names its own. Resolution order is therefore a lookup, not a precedence
puzzle: consumer route → consumer pin → project default. An explicit binding
always wins; the default only fills the gap. A project-wide default is never
allowed to override a deliberate pin.

### Keeping "no model at all" unrepresentable

Relaxing "exactly one" to "at most one" removes a write-time guarantee, so it is
replaced by two — both at write time, neither a runtime error:

1. **Create/update a consumer with neither binding → `400`** unless the project
   has `default_model_route_id` set.
2. **Clearing `default_model_route_id` → `409`** while any consumer in the
   project is inheriting it (the count of consumers with both bindings null),
   naming the count and a sample. *Repointing* it from one route to another stays
   free — that is the switch the feature exists for.

Together these make the runtime resolution a total function: every consumer that
can be read has exactly one resolvable model. The existing route-delete guard
extends to count the project reference alongside its agents.

### Accepted blast radius

Repointing a project's default deliberately changes behavior for every consumer
inheriting it. That is the feature, and it differs from provider-level
inheritance in the two ways that matter: it is a single project-scoped switch
rather than a side effect of editing a credential, and it cannot silently
override a consumer that bound itself explicitly.

### REST and permissions

`default_model_route_id` is a field on the existing project create/update
surface, governed by `projects:UpdateProject` — no new permission, no new
endpoint. The route must belong to the project (`400` otherwise), mirroring the
same-project guard on targets.

## Implementation Phases

The full module checklist in `.claude/rules/modules.md` applies to every
phase: lib in `src/lib/modelRoutes.ts`, REST + `@openapi` blocks + YAML spec,
permissions JSON, `pnpm --filter @soat/sdk generate` +
`pnpm --filter @soat/cli generate`, module doc at
`packages/website/docs/modules/model-routes.md`, tests in
`tests/unit/tests/rest/model-routes.test.ts`.

### Phase 1 — CRUD, Composite Executor, Agent Consumption (non-streaming) ✅ Done

**Deliverables:**

- `ModelRoute` model + `route_` prefix + `src/lib/modelRoutes.ts`; REST CRUD
  (incl. the `DELETE` → `409` referential guard) + OpenAPI + permissions +
  SDK/CLI regeneration + module docs.
- Shared exclusivity validator + attempt-cap and same-project target
  validation at create/update.
- `buildRoutedModel` composite `LanguageModel` with ordered fallback, error
  classification, per-target timeout signals, and `maxRetries: 0` on routed
  calls — non-streaming (`doGenerate`) failover only.
- `model_route_id` on Agent + `aiProviderId` relaxed to nullable +
  `TypedAgent.aiProvider` nullable; **both** agent resolution sites routed:
  `agentGenerationContext.ts` *and* `agentGenerationRecovery.ts` — a
  route-only agent whose client-tool continuation resumes through the
  recovery path has no pinned provider, so recovery cannot be deferred.
- Formation sync for the **agent field** (`model_route_id` added to
  `AgentResourceProperties` in `formations.yaml` + `agentsFormationModule`
  build/update/read), per the modules-rule Formations Sync checklist. (The
  `model-route` *resource type* itself is Phase 3.)

**Acceptance criteria:**

- CRUD happy path, 401, 403, cross-project 404 covered in
  `tests/unit/tests/rest/model-routes.test.ts`.
- Creating a route whose target references another project's provider returns
  400; a route whose `Σ (1 + max_retries) > 10` returns 400 naming the total.
- Setting both `model_route_id` and `ai_provider_id` on an agent returns 400
  from REST **and** produces a validation error from the formation module,
  via the same exported function; setting **neither** returns 400.
- With a route `[failing-provider, healthy-provider]` — driven by two local
  fake OpenAI-compatible servers (the `createServer` stub pattern from
  `discussionCompletion.test.ts`), the first returning 500 — a generation
  succeeds and its record names the healthy target's model.
- **No tool re-execution on failover:** a multi-step generation whose tool
  executes on step 1 and whose provider 500s on the step-2 LLM call completes
  via the second target with the tool executed **exactly once** (asserted via
  a counting fake tool server).
- **Route retries are not amplified by SDK retries:** with a route
  `max_retries: 1` and a target that always 500s, the fake server receives
  exactly 2 requests (1 + 1 retry), not 6.
- With the first target failing with a 400-class error, the generation fails
  and the fake second server received **zero** requests.
- A route-only agent (no `ai_provider_id`) completes a generation **and** a
  client-tool `requires_action` → tool-outputs resumption through the
  recovery path.
- An agent without `model_route_id` produces byte-identical resolution
  behavior to today (existing tests stay green).

### Phase 2 — Circuit Breaker, Streaming, Routing Metadata ✅ Done

**Deliverables:** in-process breaker keyed `(ai_provider_db_id, model)`;
pre-first-token fallback for streaming (the composite's `doStream` arm);
`routing` metadata written to Generation.

> Shipped alongside Phase 1: the composite's `doStream` arm and the shared
> breaker are the same object as `doGenerate`, so splitting them across two
> changes would have meant landing an executor with a knowingly untested arm.
> `routing` is written by `saveRoutingMetadata` from the completion, failure,
> and continuation paths, and is a reserved generation-metadata key so a caller
> cannot forge it.

**Acceptance criteria:**

- After `failure_threshold` consecutive failures of target 0, the next
  generation calls target 1 directly (fake server 0 receives no request);
  after `cooldown_seconds` (fake timers), target 0 is probed again.
- Two routes sharing the same `(provider, model)` target: failures driven
  through route A trip the breaker for route B as well (shared key asserted).
- Fallback generation's `GET /generations/{generation_id}` metadata contains
  `routing.target_index === 1`, `routing.fallbacks === 1`, and an `attempts`
  array naming both targets with `error_class`.
- A streaming request whose first target fails before any token succeeds via
  target 1; a fake stream that dies after emitting tokens surfaces an error
  and metadata records no additional attempts.

### Phase 3 — Project Default, Remaining Consumers, Formation Resource ✅ Done

Reshaped by the [2026-07-30 amendment](#amendment--project-default-route-2026-07-30):
chats and discussions inherit routing through the project default, so this phase
adds **no `model_route_id` column to them** — only the resolution-site change and
one column on `Project`.

**Deliverables:**

- `Project.defaultModelRouteId` + the field on the project create/update
  surface, the same-project validation, and both write-time guards (`400` for a
  consumer with neither binding and no project default; `409` for clearing a
  default that consumers inherit). The agent exclusivity validator relaxes to
  "at most one".
- The remaining resolution sites consult the chain (consumer route → consumer
  pin → project default), swapping `buildModel` for `buildRoutedModel` when it
  resolves to a route: `chatCompletionModel.ts` (chats),
  `discussionCompletion.ts` (discussions), `completionModel.ts` (memory
  extraction + consolidation).
- **Attribution after the call for routed internal completions.**
  `resolveCompletionModel` / `chatCompletionModel` return
  `{ aiProviderDbId, modelName, provider }` *before* the call for
  `recordCompletionUsage` to write. A composite cannot know its serving target
  up front, so the internal-completion metering path must read attribution back
  from the routing metadata (or the response's `modelId`) once the call
  returns. This is the one real cost the amendment does **not** remove.
- `model-route` formation resource type (`modelRoutesFormationModule.ts`,
  `ModelRouteResourceProperties` in `formations.yaml`), plus
  `default_model_route_id` wherever a project's own properties are declarable.
- Smoke-test steps via `$SOAT_CLI` for the project default and one inheriting
  consumer.

**Acceptance criteria:**

- A chat completion, a discussion run, and a memory-extraction completion that
  bind **nothing** inherit the project default and complete via the second
  target when the first fails; each records the served target for metering
  (asserted against the usage event's provider + model, not just a 200).
- A consumer with an explicit `ai_provider_id` ignores the project default
  entirely — asserted by a fake server on the default's targets receiving zero
  requests.
- Creating a consumer that binds neither returns `400` when the project has no
  default, and `201` when it does.
- Clearing a project's `default_model_route_id` returns `409` while a consumer
  inherits it, naming the count; repointing it to another route returns `200`
  and the next generation uses the new route's targets.
- Deleting a route that is a project's default returns `409`.
- A formation template declaring a `model_route` resource plans, applies, and
  reads back `targets` in snake_case; unknown fields are rejected with 400.

**As shipped, deviating from the plan in three recorded ways** — the
`Project.defaultModelRouteId` representation, the stateless chat endpoint, and
`Chat`/`Discussion` nullability. See the
[Phase 3 decisions](#phase-3-decisions--2026-07-30).

**Deferred, with an activation condition:** a per-consumer `model_route_id` on
Chat / Discussion. A project default plus explicit pins covers "most consumers
routed, some pinned"; the column is only needed for *two different routes in one
project* — worth adding when that is actually requested, not before.

## Decision log

Recorded per `.claude/rules/open-questions.md`: every open question raised
while revising this PRD, how it was resolved, and what was actually checked.
Code references are to `packages/server/src` unless noted.

```txt
Q: Where does the fallback executor live — wrapping resolveCompletionModel
   (as this PRD originally said), wrapping the generateText call, or a
   composite LanguageModel at the buildModel layer?
A: Composite LanguageModel — resolved by pareto (per-call failover inside the
   step loop cannot re-execute tools; one seam serves all five consumers;
   streaming P2 reuses it; worsens nothing — non-routed callers untouched);
   checked: resolveCompletionModel's only callers are
   memoryExtractionCompletion.ts and memoryConsolidationCompletion.ts (zero
   agent traffic); all five resolution sites end at buildModel
   (agentModel.ts); agent generation is multi-step with side-effecting tools
   (generateText + stopWhen: isStepCount, agentNonStreamGeneration.ts);
   LanguageModelV4 is a plain doGenerate/doStream interface and
   wrapLanguageModel + LanguageModelMiddleware exist in the pinned
   ai@7.0.26 / @ai-sdk/provider@4.0.3 (verified from the published .d.ts).

Q: Strict route/pin exclusivity (requires relaxing Agent.aiProviderId
   NOT NULL) or "route overrides pin" (no migration)?
A: Strict exclusivity — resolved by long-term (durability ladder: invariant
   in schema + one validator beats a prose precedence rule; pattern hygiene:
   an always-displayed dead ai_provider_id is an antipattern agents would
   replicate); checked: Agent.aiProviderId is allowNull: false
   (packages/postgresdb/src/models/Agent.ts), and the migration cost is
   compiler-enumerated — flipping TypedAgent.aiProvider to nullable makes
   pnpm typecheck name every consuming site, which are exactly the sites
   Phases 1/3 must touch anyway.

Q: Who owns retries — the route config, the SDK's built-in maxRetries, or
   both?
A: Route only; routed calls pass maxRetries: 0 — resolved by pareto (removes
   silent attempt multiplication — SDK default 2 × route retries ≈ 9 attempts
   per target during an outage — and costs nothing: non-routed calls keep the
   default); checked: generateText/streamText declare maxRetries with
   "Default: 2" in the pinned SDK's .d.ts.

Q: Circuit-breaker key — per (route, target_index) or per
   (ai_provider_db_id, model)?
A: (ai_provider_db_id, model), shared across routes — resolved by pareto
   (strictly faster outage learning when routes share a backend; worsens
   nothing — the only shared state is "is this backend healthy", the exact
   signal the breaker exists for; skip policy stays per-route); checked: the
   breaker is in-process and keyed lookup is equal cost either way.

Q: How is the attempt cap enforced — create-time validation or runtime clamp?
A: Create/update-time 400 (Σ (1 + max_retries) ≤ 10) — resolved by long-term
   (deterministic enforcement at write; a runtime clamp silently truncates
   configured behavior); checked: nothing else in the module validates at
   runtime what is knowable at write time.

Q: How is a per-target timeout enforced?
A: Per-attempt AbortSignal.timeout composed with the caller's signal —
   resolved by pareto (the generation paths already thread abortSignal
   end-to-end, so no new cancellation machinery); checked: abortSignal
   parameters in agentGeneration.ts, agentNonStreamGeneration.ts,
   discussionCompletion.ts.

Q: Are failed attempts that burned tokens metered?
A: No — accepted, documented gap — resolved by long-term (debt containment:
   the gap is visible via Phase 2's routing.attempts rather than silent, and
   closing it needs usage data error responses don't carry); checked: the
   metering path prices off the persisted generation, which records only the
   served attempt.

Q: Which phase gets the DELETE → 409 referential guard and the agent-field
   formation sync?
A: Both Phase 1 — resolved by pareto (agents reference routes from day one,
   so dangling refs and formation drift are representable from day one;
   cost is one count query and one schema property); checked: Phase 1's own
   deliverables create the referencing column and the formation module
   already round-trips agent fields (.claude/rules/modules.md Formations
   Sync).

Q: Should the target list live on AiProvider, so every consumer of that
   provider inherits failover automatically, instead of a separate
   ModelRoute each consumer references? (raised 2026-07-30, after Phases 1-2)
A: No — keep ModelRoute, add Project.default_model_route_id for the
   inheritance — resolved by long-term (boundary integrity: AiProvider is a
   credential + endpoint, and a target is a (provider, model) pair the
   provider row cannot express; durability ladder: the write-time attempt cap
   survives only while a route's budget is a pure function of its own
   targets); checked: Agent, Chat and Discussion each declare their own
   nullable `model` overriding the provider's default_model
   (packages/postgresdb/src/models/{Agent,Chat,Discussion}.ts), so one
   provider-level fallback list cannot be correct for two consumers pinning
   different models on the same credential; PriceBook and UsageEvent are keyed
   by (aiProviderId, model), so a provider answering as another provider
   recreates the gateway mis-attribution this module exists to avoid;
   AiProvider's own fields are secretId / provider / defaultModel / baseUrl /
   config.

Q: Precedence when a project default and a consumer binding both exist?
A: The consumer always wins; the default only fills "neither" — resolved by
   long-term (pattern hygiene: a project-wide switch that can override a
   deliberate pin is the "route overrides pin" antipattern this PRD already
   rejected, one scope up); checked: the resolution chain has three steps and
   the revised invariant makes exactly one of them apply, so no precedence
   rule lives in prose.

Q: Relaxing "exactly one binding" to "at most one" drops a write-time
   guarantee — how does "this consumer has no model at all" stay
   unrepresentable?
A: Two write-time guards — 400 on a consumer that binds neither while the
   project has no default, 409 on clearing a default that consumers inherit
   (repointing stays free) — resolved by long-term (durability ladder:
   deterministic enforcement at write, keeping runtime resolution a total
   function instead of a new failure mode); checked: this mirrors the
   route-delete dependent guard already shipped in Phase 1, which extends to
   count the project reference alongside its agents.
```

### Phase 3 decisions — 2026-07-30

Three questions were raised while implementing Phase 3 and resolved under
`.claude/rules/open-questions.md`.

```txt
Q: Does Project.defaultModelRouteId store the route's internal id behind a
   foreign key (like Agent.modelRouteId), or its public id with no FK?
A: The public id, no FK — resolved by long-term (a foreign key here would close
   a Project ↔ ModelRoute cycle, and Postgres creates FK constraints inline in
   CREATE TABLE, so `sync()` would have to create one of the two tables before
   the table it references; referential integrity is instead enforced at write
   time by the same-project check and the route-delete guard, both of which this
   phase ships and tests); checked: ModelRoute already declares
   `@ForeignKey(() => Project)` on projectId, so the cycle is real; Project
   itself already holds a public-id reference list in `guardrailIds` with a
   lib-level delete guard, so this is the model's existing pattern rather than a
   new one; the guard is deterministic enforcement, not prose.

Q: Does the stateless `POST /chat/completions` endpoint also inherit the project
   default, making its `ai_provider_id` optional?
A: No — it stays required — resolved by long-term (boundary integrity: that call
   belongs to no chat and no project; today its project is derived *from* the
   provider, so inheriting a default would require inventing a `project_id`
   body field, i.e. new public API surface the PRD does not ask for, and a
   request that names neither would have no project to look a default up in);
   checked: `resolveChatModel`'s attribution reads `resolved.projectId` off the
   provider secret, and `chatsRouter.post('/chat/completions')` takes no
   project parameter. Chat-scoped completions — the ones the acceptance
   criteria name — do inherit, through `resolveChatScopedModel`.

Q: Chats and discussions get no `model_route_id` column, but their
   `aiProviderId` is `allowNull: false` — how does a consumer "bind nothing"?
A: Relax both columns to nullable — resolved by pareto (it is the only way the
   amendment's own acceptance criteria are representable, and it costs nothing
   elsewhere: `mapDiscussion` already emitted `ai_provider_id` as nullable, and
   the same write-time guard that protects agents protects both);
   checked: `packages/postgresdb/src/models/{Chat,Discussion}.ts` both declared
   `allowNull: false`; `DiscussionRecord.ai_provider_id` in discussions.yaml was
   already `nullable: true`, so the read contract did not change for
   discussions; `discussionRuns.ts` was asserting non-null with
   `discussion.aiProvider!.publicId`, which is now the optional
   `defaultAiProviderId` the turn resolver falls through on.
```

### Adjacent fixes shipped with Phase 3

Two pre-existing gaps were in the blast radius and fixed rather than left:

- **`ModelRoute` was missing from the project-delete dependent count** (Phase 1).
  `countProjectDependents` never counted it, so deleting a project holding a
  route hit the database's RESTRICT foreign key and surfaced as a `500` instead
  of `PROJECT_HAS_DEPENDENTS`. It is now counted, and the force-cascade destroys
  routes after agents (whose `modelRouteId` FK points at them).
- **`discussion` was missing from the formation `type` enum** in
  `formations.yaml`, despite having a `DiscussionResourceProperties` schema, a
  registered module, and a `oneOf` entry. Added alongside the new `model_route`.
  The formations module doc listed neither, and was also missing `quota` (which
  the enum did have); all three are now listed there.

### Forwarded questions — resolved 2026-07-30

Both questions were forwarded to the product owner per the open-questions
gate and resolved on 2026-07-30. Phase 1 has no remaining open gates.

- **Error-class mapping (public API contract — high-risk class). APPROVED
  as recommended.** The classification table above is frozen as the public
  contract for `retry_on` and Phase 2's `routing.attempts[].error_class`:
  `429 → rate_limited`; abort/per-target timeout → `timeout`; 5xx /
  `isRetryable` / connection-level failure → `provider_error`; everything
  else (400-class, auth, content policy) fails fast with no failover.
  Supporting evidence reviewed at sign-off: the mapping is verified against
  the pinned `@ai-sdk/provider@4.0.3` and is a finer-grained version of the
  provider/caller boundary the codebase already enforces in
  `src/lib/providerError.ts` (`toProviderDomainError` unwraps `RetryError`
  and treats `APICallError` plus connection-level fetch failures as
  provider-shaped) — it introduces no new taxonomy.
- **Gateway overlap (product intent). PRIORITY CONFIRMED — build all three
  phases.** The external-gateway workaround (LiteLLM/OpenRouter via the
  `gateway` slug) was weighed and judged insufficient: it requires operators
  to run and secure a second service holding provider credentials outside
  SOAT's secrets module, it blinds SOAT's observability (the Generation
  records the gateway's alias, not the provider that actually answered — no
  `routing.attempts`, wrong attribution in usage/price-book costing), and
  the routing config lives outside SOAT's IAM, formations, and audit
  surface. SOAT-native, project-scoped, observable routing is in scope for
  the platform's "production-ready agent infrastructure" positioning.

## Risks

- **Retry amplification.** Bounded by construction: the create-time attempt
  cap (≤ 10 total attempts) and `maxRetries: 0` on routed SDK calls. The
  residual risk is many *concurrent* generations hammering a dead provider,
  which the Phase 2 breaker addresses.
- **Per-node breaker divergence.** Nodes learn outages independently; a large
  fleet still sends `failure_threshold` requests per node into a dead
  provider. Accepted for v1 (see decision); revisit only with evidence.
- **Nullable-provider fallout.** Relaxing `Agent.aiProviderId` touches every
  site that assumes a pinned provider. Mitigated by the type flip
  (compiler-enumerated) and the Phase 1 acceptance criterion exercising the
  recovery path with a route-only agent — the least-traveled consumer.
- **Model-name portability.** A route target names its model explicitly, so
  the cross-provider "meaningless model name" hazard that
  `resolveCompletionModel` guards against does not apply — but operators can
  still configure a wrong model per target; creation-time validation is
  name-format only.
- **Behavioral drift across targets.** Failover changes the answering model
  mid-conversation — and, with per-call failover, potentially mid-*run*
  between steps of one generation. Quality-sensitive consumers should order
  same-family models. Documented, not enforced.
