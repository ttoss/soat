# PRD: Strict, Spec-Derived Request-Body Validation

Make the REST API reject **unknown request-body fields** with a `400`, using a single
helper that derives the allowed field set from the OpenAPI specs — the same source of
truth that already drives the SDK, CLI, and MCP surface. Converge every mutating route
on this one mechanism so the "spec is the contract" guarantee holds at runtime, not just
in documentation.

## Implementation Status

> **Status: implemented (Phases 1–2).** The mechanism and the full per-module rollout
> have shipped on PR #296. Phase 3 (automatic middleware, deep validation) remains
> deferred. Implementation notes below the table.

| Component | Status | Notes |
| --- | --- | --- |
| `getRequestSchemaFields({ schemaName })` | ✅ Implemented | Resolves a **named** component schema → `{ allowedFields, requiredFields }` in camelCase |
| `getRouteRequestSchemaFields({ method, path })` | ✅ Implemented | Resolves a route's request body schema — inline **or** `$ref` — from the merged spec; returns `null` for open maps / no body. Normalizes `:param` → `{param}` and the `/api/v1` prefix |
| Shared `rejectUnknownFields({ method, path, body })` | ✅ Implemented | `src/lib/requestValidation.ts`; throws `DomainError('VALIDATION_FAILED')`; no-ops when there is no property-based body schema |
| `agents` migrated to shared helper + `DomainError` | ✅ Implemented | Replaced the hand-rolled `KNOWN_*` sets and raw `ctx.body = { error }` (fixes an `errors.md` violation) |
| Per-module rollout | ✅ Implemented | All CRUD modules instrumented (see exclusions below) |
| Automatic route→schema middleware | ❌ Deferred | Phase 3 — the route resolver already exists; wrapping it in middleware is the remaining step |
| Deep (nested) field validation | ❌ Deferred | Phase 3 (optional) — match the formation layer's depth |

### Implementation notes

**Route-based resolution.** Most modules declare their request bodies as *inline* schemas
(no `$ref`), so a `schemaName`-only helper could not cover them. `getRouteRequestSchemaFields`
resolves the body schema by `(method, path)` against the merged spec, following a `$ref` when
present and reading inline `properties` otherwise. `rejectUnknownFields` is called as
`rejectUnknownFields({ method, path: '<router path>', body: ctx.request.body as Record<string, unknown> })`.

**Exclusions (intentionally lenient or open-ended):**
- `POST /chat/completions`, `POST /chats/:chat_id/completions` — LLM completion endpoints that
  legitimately accept extra sampling params (`temperature`, `top_p`, …).
- `POST /embeddings`, `POST /tools/:tool_id/call` — passthrough/open input.
- `POST /files` — intentionally accepts-and-ignores client read-only/storage fields (`path`,
  `storage_*`) as a security behavior; covered by dedicated "ignores …" tests.
- `POST /users/login`, `POST /users/bootstrap` — auth flows left untouched.
- Tags endpoints (`PUT|PATCH /*/tags`) — open `additionalProperties` string maps; the resolver
  returns `null` for them, so the helper no-ops.
- No-body routes (cancel/resume/rotate-secret) — no request schema.

**Spec drift fixed during rollout** (handler accepted a field the schema omitted; strict
validation would otherwise have rejected valid requests): `provider` on the ai-providers update
schema; `instructions`/`external_id`/`agent_id`/`chat_id` on the actors schemas; `title`/
`metadata`/`tags` on the documents create schema; `name` on the conversations update schema
(and dropped its erroneous `required: [status]`). SDK and CLI were regenerated.

> **Key finding:** the codebase is **internally inconsistent today**. The *formation*
> layer already rejects unknown fields from the same specs (`formationSpecLoader.ts` +
> `pushUnknownFieldErrors`), while every REST route except `agents` silently
> accepts-and-ignores unknown fields. This PRD's primary value is removing that split, not
> inventing a new behavior.

## Background — what already exists

Three relevant facts about the current system:

1. **The spec is already the single source of truth.** `packages/server/src/rest/openapi/v1/*.yaml`
   generates the SDK (`@soat/sdk generate`), the CLI route manifest (`@soat/cli generate`),
   and the MCP tool surface at runtime (`src/lib/soatTools.ts`, which already walks
   `spec.paths → requestBody → content['application/json'].schema.$ref`). Runtime body
   validation is the one place the spec is *not* yet authoritative.

2. **Two divergent validation conventions coexist:**
   - **Strict (formations):** `formationSpecLoader.loadModuleSpec` reads a `*ResourceProperties`
     schema and `pushUnknownFieldErrors` emits `Unknown <resource> field '<key>'. Allowed: …`
     for any field not in the spec. This is exactly the behavior we want, already proven.
   - **Lenient (REST, except agents):** handlers destructure known fields out of
     `ctx.request.body` and ignore the rest. A typo like `prompt` instead of `instructions`
     is silently dropped — the client gets a `200` and a resource that doesn't match intent.
   - **One-off strict (agents):** `agents.ts` hand-rolls `KNOWN_*_AGENT_FIELDS` sets and
     `findUnknownFields`. As of PR #296 the sets are spec-derived, but the rejection path
     still uses raw `ctx.status = 400; ctx.body = { error: '…' }`.

3. **The error stack is ready.** `ERROR_CODES.VALIDATION_FAILED` (HTTP 400) already exists in
   `src/errors/codes.ts`, and `errorLogger` middleware renders any thrown `DomainError` as
   `{ error: { code, message, meta } }`. The agents route's manual `{ error: string }`
   actually **violates** `.claude/rules/errors.md` ("Do not set `ctx.body = { error }`
   manually — throw `DomainError`"); the shared helper fixes this in passing.

## Why strict is the right long-term default for SOAT

The standard argument *against* strict rejection is Postel's law / forward-compat — public
APIs (Stripe, GitHub) deliberately ignore unknown params so millions of hand-written
integrations survive version skew. That argument is weak **for SOAT specifically**:

- **First-party clients are generated from the spec and cannot send unknown fields.** The
  typed SDK and the CLI manifest both come from the same YAML, so strict rejection costs the
  consumers you control essentially nothing — they move in lockstep with the server.
- **A primary consumer is an LLM, and models hallucinate field names.** The MCP surface is
  derived from these specs and called by agents. Under accept-and-ignore, a model that sends
  `max_token` instead of `max_tokens` gets a `200` and silently loses its intent — the worst
  failure mode. Strict rejection returns `400 Unknown field 'max_token'. Allowed: …`, a
  corrective signal the agent can act on next turn. For agent infrastructure, fail-loud beats
  tolerance.
- **It removes an existing inconsistency** rather than adding a novel behavior (see Background).

The deciding principle: an API whose spec is the source of truth for SDK/CLI/MCP should have
that spec be **authoritative at runtime**. Strict body validation is what makes
"the spec is the contract" literally true.

### The real risk, and how it's bounded

The genuine downside is external **hand-written** HTTP clients that today send extra fields
and get away with it. Mitigations:

- The error always **lists the allowed fields** (formations already does this) — high-signal DX.
- Roll out behind a deliberate version bump with a changelog entry, not a silent flip.
- Keep it **body-only** for v1 (query/path params unchanged).
- Ship per-module so each surface can be reviewed for legitimate "extra field" callers first.

## Implementation Phases

### Phase 1 — Shared helper + migrate agents (small, no net behavior change)

**Goal:** One reusable, spec-derived rejection primitive that throws a `DomainError`, with
`agents` as its first caller (and its `errors.md` violation fixed).

**Deliverables:**

- `rejectUnknownFields({ schemaName, body })` in `src/lib/openapiSpec.ts` (or a sibling
  `src/lib/requestValidation.ts`), built on the existing `getRequestSchemaFields`:

  ```ts
  export const rejectUnknownFields = (args: {
    schemaName: string;
    body: Record<string, unknown>;
  }): void => {
    const { allowedFields } = getRequestSchemaFields({ schemaName: args.schemaName });
    const unknown = Object.keys(args.body).filter((k) => !allowedFields.has(k));
    if (unknown.length > 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Unknown field(s): ${unknown.join(', ')}. Allowed: ${[...allowedFields].join(', ')}`,
        { unknownFields: unknown }
      );
    }
  };
  ```

- Migrate `agents.ts`: replace `KNOWN_*_AGENT_FIELDS` + `findUnknownFields` +
  `ctx.status/ctx.body` with `rejectUnknownFields({ schemaName: 'CreateAgentRequest', body })`
  (and `UpdateAgentRequest` for PUT/PATCH). Net behavior is unchanged **except** the error
  body becomes the structured `{ error: { code, message, meta } }` form.
- Update the agents tests that assert the old `{ error: string }` shape to the
  `{ error: { code: 'VALIDATION_FAILED', … } }` shape (`response.body.error.message` matches
  `/prompt/`). This is the only externally visible change in Phase 1.

**Unlocks:** A single primitive every other module can adopt; agents now conforms to `errors.md`.

---

### Phase 2 — Per-module rollout (opt-in, the contract change)

**Goal:** Apply `rejectUnknownFields` to the mutating routes (`POST`/`PUT`/`PATCH`) of each
module, one module per PR, so reviewers can spot any legitimate extra-field caller before
flipping it.

**Per-module checklist (repeat for each):**

- Call `rejectUnknownFields({ schemaName: '<Create|Update>XRequest', body })` at the top of
  each mutating handler, before field parsing.
- Add a test: `POST`/`PUT` with a bogus field → `400` + `error.code === 'VALIDATION_FAILED'`.
- Confirm the request schema in the module's YAML actually lists every field the handler
  accepts (this is where pre-existing spec/handler drift surfaces — fix the spec, then
  regenerate SDK/CLI per `modules.md`).

**Ordering (lowest-risk first):** internal/config-heavy resources where typos are most
harmful and external callers least likely — `tools`, `ai-providers`, `actors`, `chats`,
`conversations`, `orchestrations` — then the rest. `users`/`projects` last (most likely to
have ad-hoc callers).

**Unlocks:** Uniform fail-loud behavior; the spec becomes runtime-authoritative across the API.

---

### Phase 3 — Optional enhancements (out of scope for v1)

- **Automatic middleware.** Instead of a per-handler call, a single middleware resolves the
  request's OpenAPI operation from the matched route (`${method} ${pathTemplate}`) via the
  merged spec, reads its `requestBody` schema `$ref`, and validates — zero per-route code.
  `soatTools.ts` already demonstrates the path→requestBody-schema walk, so the resolver
  exists in spirit. Deferred because it couples to the router's matched-route exposure and
  needs a way to opt routes out; the explicit helper is lower-risk for v1.
- **Deep (nested) validation.** Phase 1–2 validate only top-level keys (matching agents
  today), so a typo in `knowledge_config.memory_ids` still slips through. The formation layer
  already validates nested `*ResourceProperties` depth; unifying on that depth would close the
  gap but is materially more work (recursive schema walk, `oneOf`/`anyOf` handling).
- **`required`-field enforcement.** `getRequestSchemaFields` already returns `requiredFields`;
  a future pass could replace per-handler "X is required" checks with spec-derived ones.

## Scope — files to touch (Phases 1–2)

| Surface | File | Change |
| --- | --- | --- |
| Helper | `src/lib/openapiSpec.ts` (or new `src/lib/requestValidation.ts`) | Add `rejectUnknownFields` |
| Errors | `src/errors/codes.ts` | None — reuse existing `VALIDATION_FAILED` |
| Route (Phase 1) | `src/rest/v1/agents.ts` | Replace hand-rolled check with helper; drop `findUnknownFields` |
| Routes (Phase 2) | `src/rest/v1/<module>.ts` | One call per mutating handler |
| OpenAPI (as needed) | `src/rest/openapi/v1/<module>.yaml` | Fix any field the handler accepts but the schema omits |
| SDK / CLI | (generated) | `pnpm --filter @soat/sdk generate`; `pnpm --filter @soat/cli generate` if any YAML changed |
| Tests | `tests/unit/tests/rest/<module>.test.ts` | Unknown-field `400` case per module; update agents error-shape assertions |
| Docs | `packages/website/docs/modules/<module>.md` | Note strict-field behavior where a module page documents request shape |

**Not in scope:** query/path-param validation; the MCP layer (it has its own
`mcp/tools/caseTransform.ts` path and camelCase contract); the formation layer (already strict).

## Test Plan (TDD — red first)

Per `.claude/rules/quality-assurance.md`, write the failing test before the production code.

- **Helper unit** (`tests/unit/tests/lib/openapiSpec.test.ts`, real spec — no mocks):
  - unknown field → throws `DomainError` with `code === 'VALIDATION_FAILED'` and `meta.unknownFields`.
  - all-known body → does not throw.
  - error message includes the allowed-field list.
- **Per-module REST** (`tests/unit/tests/rest/<module>.test.ts`): mutating request with a
  bogus field → `400`, `response.body.error.code === 'VALIDATION_FAILED'`; happy path still
  `2xx`. Keep the existing `401`/`403` coverage.
- **Agents migration:** update the three existing "unknown fields … return 400" tests to the
  structured error shape.
- **Smoke** (`tests/smoke-tests.sh`): optional — add one `$SOAT_CLI` step asserting a bogus
  field is rejected, to prove end-to-end wiring (the CLI itself won't send unknown fields, so
  this would use a raw `/mcp`-style or documented escape hatch only if convenient).

**Definition of Done:** `pnpm typecheck`, `pnpm eslint --fix`, `pnpm test`, and
`pnpm run -w smoke-tests` all green; no `as any` / `as unknown`; no `console.log`.

## Risks & Limitations

- **Breaking change for lenient external callers (primary risk).** Any hand-written client
  relying on extra fields being ignored will start getting `400`s. Bounded by: allowed-field
  list in the error, per-module rollout with review, body-only scope, and a versioned
  changelog. The generated SDK/CLI are unaffected by construction.
- **Spec/handler drift surfaces as new failures.** If a handler quietly accepts a field the
  YAML doesn't list, enabling strict mode will reject it. This is the validation *working* —
  the fix is to add the field to the spec (and regenerate), not to weaken the check. Expect a
  few such finds during Phase 2; that surfacing is a benefit.
- **Top-level only (v1).** Nested-object typos remain silent until Phase 3. Documented so
  authors don't assume deep coverage.
- **Per-handler boilerplate** until/unless Phase 3 middleware lands — one call per mutating
  handler. Acceptable and explicit; far better than reintroducing hardcoded per-module lists.

## Resolved / Proposed Decisions

1. **Strict rejection is the target default**, derived from the spec, shared across modules —
   not per-module hardcoded lists (those would drift and are worse than the status quo).
2. **Reuse `VALIDATION_FAILED` (400)** rather than minting an `UNKNOWN_FIELD` code; the
   `meta.unknownFields` array carries the specifics.
3. **Throw `DomainError`, never raw `ctx.body`** — conforms to `errors.md` and yields the
   structured error shape the SDK/CLI already expect.
4. **Roll out per module, opt-in**, lowest-external-exposure modules first; this is a
   contract change gated on team sign-off, not a mechanical sweep.
5. **Body-only, top-level for v1**; nested depth and automatic middleware are deferred
   Phase 3 enhancements, explicitly out of scope here.
