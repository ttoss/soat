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
| DELETE | `/api/v1/model-routes/{route_id}`    | Delete — `409` if referenced by a consumer (Phase 1: agents reference routes from day one, so referential protection ships with them) |

## Implementation Phases

The full module checklist in `.claude/rules/modules.md` applies to every
phase: lib in `src/lib/modelRoutes.ts`, REST + `@openapi` blocks + YAML spec,
permissions JSON, `pnpm --filter @soat/sdk generate` +
`pnpm --filter @soat/cli generate`, module doc at
`packages/website/docs/modules/model-routes.md`, tests in
`tests/unit/tests/rest/model-routes.test.ts`.

### Phase 1 — CRUD, Composite Executor, Agent Consumption (non-streaming) ❌ Not started

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

### Phase 2 — Circuit Breaker, Streaming, Routing Metadata ❌ Not started

**Deliverables:** in-process breaker keyed `(ai_provider_db_id, model)`;
pre-first-token fallback for streaming (the composite's `doStream` arm);
`routing` metadata written to Generation.

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

### Phase 3 — Remaining Consumers + Formation Resource ❌ Not started

**Deliverables:** `model_route_id` accepted by the remaining resolution
sites — `chatCompletionModel.ts` (chats), `discussionCompletion.ts`
(discussions), and `completionModel.ts` (memory extraction + consolidation
`ai_provider_id` overrides) — each swapping its `buildModel` call for
`buildRoutedModel` when a route is configured; `model-route` formation
resource type (`modelRoutesFormationModule.ts`,
`ModelRouteResourceProperties` in `formations.yaml`); smoke-test steps via
`$SOAT_CLI`.

**Acceptance criteria:**

- A discussion run, a chat completion, and a memory-extraction completion
  configured with a route whose first target fails complete successfully via
  the second target.
- A formation template declaring a `model-route` resource plans, applies, and
  reads back `targets` in snake_case; unknown fields are rejected with 400.

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
```

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
