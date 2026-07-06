# PRD — Server Test Suite Quality Improvements

**Status:** Draft
**Scope:** `packages/server/tests/unit/` (REST integration + lib tests)
**Author:** Test quality review
**Related branch:** `claude/soat-server-tests-quality-v290a4`

## 1. Background

The `@soat/server` unit suite is large and healthy: ~2,468 tests across 104 files
(~47k lines), running as true integration tests against `app.callback()` with a real
pgvector Postgres testcontainer. The intended discipline is documented in
`.claude/rules/tests.md`:

- **No database mocking** — set up state through the REST API.
- **Only external I/O is mocked** (LLM calls via the shared `mockCreateGeneration`
  spy; `ollama`), always via `jest.spyOn`, never `jest.mock`/`jest.doMock` of
  internal modules that are transitively imported by `app.ts`.
- **`jest.clearAllMocks`** for the shared spy in `afterEach`, never `restoreAllMocks`.

A full review confirmed the suite mostly lives up to this. This PRD captures the
concentrated set of defects and drifts that do **not**, ranked by risk.

## 2. Goals

- Eliminate tests that pass regardless of behavior (false confidence).
- Close authorization-coverage gaps (every route: happy path + 401 + 403 + edge).
- Remove flakiness sources (fixed real-time sleeps, leaked global listeners).
- Realign the heavily-mocked `lib/` cluster with the "real DB, no internal mocks"
  premise, or explicitly justify the exceptions.
- Reduce brittleness (exact-string error bodies) and boilerplate (copy-pasted setup).

## 3. Non-Goals

- Rewriting the testcontainer/bootstrap infrastructure.
- Changing production error shapes purely for test convenience (except where a route
  demonstrably violates the `DomainError` contract in `.claude/rules/errors.md` — see P1-3).
- Increasing raw coverage percentage as an end in itself; the aim is behavioral value.

## 4. Requirements

Priorities: **P0** = correctness of the tests themselves (a passing test is lying);
**P1** = coverage & reliability gaps; **P2** = maintainability & consistency.

---

### P0-1 — Fix the vacuous "message deleted" assertion

**Problem.** `rest/conversations.test.ts:524` reads `m.documentId` from a response
whose field is `document_id` (snake_case). The `.some(...)` callback can never match,
so `expect(...).toBe(false)` passes whether or not the message was actually deleted.
The same file uses the correct `document_id` at lines 382 and 489.

**Change.** Use `m.document_id`. After the fix, temporarily break the delete handler
locally to confirm the test now fails (red), then restore.

**Acceptance criteria.**
- `rest/conversations.test.ts` asserts on `document_id`.
- Mutating the delete route to a no-op makes the test fail.
- A grep for `documentId` (camelCase) in `rest/` response assertions returns nothing
  unexpected.

**Effort:** XS.

---

### P0-2 — Audit for sibling "field-casing" vacuous assertions

**Problem.** The `conversations` bug is a class, not an instance: response bodies are
snake_case (caseTransform middleware), so any test asserting on a camelCase field of a
response body silently no-ops.

**Change.** Grep `rest/` test files for camelCase property access on `res.body` /
`response.body` / `.data` array elements (e.g. `\.body\.[a-z]+[A-Z]`,
`m: \{ [a-z]+[A-Z]`). Triage each hit; fix or confirm intentional (e.g. OpenAPI spec
endpoint, which bypasses caseTransform and legitimately stays camelCase).

**Acceptance criteria.**
- Documented list of every camelCase-on-response-body access with a verdict
  (bug / intentional).
- All confirmed bugs fixed with a red/green check.

**Effort:** S.

---

### P1-1 — Add 403 coverage to `rest/actors.test.ts`

**Problem.** `rest/actors.test.ts` has **zero** 403/permission tests (no `noPermToken`
created), while the sibling `rest/actorTags.test.ts` tests 403 on every method. This is
the most conspicuous authz gap in the suite.

**Change.** Introduce a `noPermToken` user (member without the actors permission) and
add a 403 case to each mutating/reading actor route, mirroring `actorTags.test.ts`.

**Acceptance criteria.**
- Every actor route has happy path + 401 + 403 (+ 404 where a resource id is addressed).
- `grep -c 403 rest/actors.test.ts` > 0.

**Effort:** S.

---

### P1-2 — Close partial 403 gaps in `documents`, `files`, `chats`

**Problem.** 403 is tested on only a subset of routes:
- `rest/documents.test.ts`: 403 only on PATCH, ingest, re-ingest — not POST/GET/GET:id/DELETE.
- `rest/files.test.ts`: 403 on create/list/base64/presigned — not GET:id, download,
  PATCH metadata, DELETE, tag routes.
- `rest/chats.test.ts`: 403 only on POST and GET-list — not `/:id`, DELETE, completions.

**Change.** Add the missing 403 cases using the existing `noPermToken` pattern in each file.

**Acceptance criteria.** Every route in these three files has an explicit 403 test
(or a documented reason it has no permission gate).

**Effort:** M.

---

### P1-3 — Replace brittle exact-string error assertions; fix route contract drift

**Problem.** `.claude/rules/errors.md` requires `DomainError` bodies to be objects
(`{ error: { code, message } }`) and warns against string matching. Several tests assert
plain-string bodies, which are both brittle and evidence that the underlying route still
returns a legacy string error:
- `rest/formations.test.ts:782,800,823,900,915,974,1082` — `toBe('Missing required parameters')`.
- `rest/conversations.test.ts:440,552` — `toBe('Conversation ... not found')`.
- `rest/files.test.ts:237,500,798`, `rest/webhooks.test.ts:496,537`,
  `rest/agents.test.ts:126,592`.

**Change.** For each: decide whether the **route** should emit a `DomainError` (preferred).
If yes, update the handler to throw the appropriate code (per `errors/codes.ts`) and change
the test to assert `error.code` + `error.message` `toMatch(/.../i)`. If the string body is
intentional legacy behavior, replace exact equality with a regex and add a code comment
explaining why it is not a `DomainError`.

**Note.** Distinguish true error envelopes from status-payload fields that happen to be
named `error` (e.g. `ingestionRules.test.ts:1040`, `documents.test.ts` status payloads) —
those are not defects.

**Acceptance criteria.**
- No `expect(res.body.error).toBe('<literal>')` remains for a route that returns a `DomainError`.
- Any route changed to `DomainError` has its OpenAPI error responses kept in sync.

**Effort:** M (touches production route handlers — coordinate with `errors.md` owners).

---

### P1-4 — De-flake `lib/webhookDispatcher.test.ts`

**Problem.** 13 tests fire `emitEvent` then `await setTimeout(200–500ms)` hoping the
fire-and-forget dispatch has finished (webhookDispatcher.test.ts:59,92,118,146,181,218,…).
This is timing-dependent under CI load. It also contains a tautological assertion
(`:69` `toBeGreaterThanOrEqual(0)`), tests with no assertions (`:95,121,340`), and
cross-test webhook accumulation (`:443-446`) i.e. order coupling.

**Change.** Replace fixed sleeps with a promise-based signal (resolve a promise inside the
dispatch boundary — the pattern already used well in `rest/sessions.test.ts:959-1022`) or a
bounded predicate poll on the observable side-effect (delivery row / mock call), as in
`lib/generationLifecycle.test.ts:10-18`. Remove tautological/empty assertions or replace
with meaningful ones. Isolate per-test webhook state.

**Acceptance criteria.**
- No fixed `setTimeout` "settling" delays remain; waits are signal- or predicate-bounded.
- Every test has at least one meaningful assertion.
- Tests pass when run in isolation and in a randomized order.

**Effort:** M.

---

### P1-5 — Fix the leaked `eventBus` listener and audit global singleton state

**Problem.** `lib/eventBus.test.ts:12` calls `onEvent(handler)` on the shared singleton
and never removes it, leaking into every later test in the run.
`orchestrationScheduler.test.ts:79` shows the correct pattern (`eventBus.off` in `finally`).

**Change.** Register/unregister listeners within the test's lifecycle (`finally` or
`afterEach`). Audit other shared singletons (`policyCompiler.test.ts:8` registry mutation
at import) for the same leak.

**Acceptance criteria.** No test leaves a listener registered on a shared bus after it
completes; suite passes under randomized file order.

**Effort:** S.

---

### P1-6 — Reduce real wall-clock sleeps in TTL/settling tests

**Problem.** `rest/sessions.test.ts` uses ~7 real `setTimeout(1500)` waits for
1-second-TTL expiry (sessions.test.ts:1782,1839,1878,1905,1996,2096,2128), adding ~10s+ of
runtime and residual flakiness. `rest/memoryExtraction.test.ts` uses fixed 300–400ms
settling sleeps.

**Change.** Prefer injecting/advancing the clock the TTL logic reads (or exposing a test
seam) over sleeping. Where a real sleep is unavoidable, keep it but centralize behind a
named helper with a comment. Convert `memoryExtraction` settling sleeps to predicate polls
(`waitForEntries` already exists — remove the trailing fixed `sleep`).

**Acceptance criteria.**
- TTL tests no longer depend on ≥1s real sleeps (or a documented reason remains).
- `memoryExtraction` no longer uses fixed post-signal sleeps.

**Effort:** M.

---

### P2-1 — Realign the heavily-mocked `lib/` cluster with the real-DB premise

**Problem.** A cluster of `lib/` files contradicts "real Postgres, no internal mocks":
- `lib/agentGeneration.test.ts` and `lib/agentGenerationRecovery.test.ts` use
  `jest.doMock('src/db')`, `jest.doMock('src/lib/generations')`, `...eventBus`,
  `...aiProviders`, etc. + `resetModules` — on modules that **are** on the `app.ts`
  import chain, which `.claude/rules/tests.md` explicitly forbids.
- `lib/formations.test.ts` stubs `db.Formation.findOne`/`findAll` with `{ id: 1 } as any`
  throughout and duplicates `rest/formations.test.ts` coverage.
- `lib/formation-modules.test.ts` (~2,500 lines) and `formationsResourceHandlers.test.ts`
  `jest.spyOn` ~30–40 internal lib functions and carry the bulk of the suite's
  ~125 `as any`/`as unknown` casts.

**Change (per file, in order of value).**
1. For `formations.test.ts`: delete assertions already covered by `rest/formations.test.ts`;
   convert the remainder to real-DB fixtures created via the API/models.
2. For `agentGeneration*`: where the behavior is reachable through the REST generate flow,
   move it to the existing `rest/agentGeneration.test.ts` real-DB pattern with the sanctioned
   `mockCreateGeneration`/`ai` spy. Keep only genuinely-internal seams as lib tests, and
   document the `ai`-module `jest.mock` exception (`streamText` non-configurable) where it
   is truly required (as `agentGenerationHelpers.test.ts:483-486` already does).
3. For `formation-modules.test.ts`: collapse the repetitive per-resource adapter assertions
   with `test.each`, and prefer real lib calls over spying every CRUD function where feasible.

**Acceptance criteria.**
- No `jest.doMock`/`jest.mock` of an internal module that is transitively imported by
  `app.ts` (verify against the import chain), except documented, unavoidable external-lib
  cases (`ai`).
- `as any`/`as unknown` count in `lib/` reduced substantially (target: eliminate in
  `formations.test.ts`; document any residual).
- No net loss of behavioral coverage (rest counterparts assert the same properties).

**Effort:** L (largest item; can be split per-file across PRs).

---

### P2-2 — Prune low-value / redundant tests

**Problem.**
- `lib/agents.test.ts` re-tests `resolveUrlPathParams`, a pure re-export already covered by
  `lib/agentToolResolver.test.ts:896-951`.
- `lib/agentModel.test.ts` — 17 tests assert only `toBeDefined()`; they exercise branches
  but cannot distinguish correct from incorrect wiring.
- `lib/orchestrationRunActions.test.ts` — every test hits a nonexistent run and asserts the
  same `ORCHESTRATION_RUN_NOT_FOUND`; the file comment concedes it exists only for branch
  coverage.
- `lib/policyCompiler.test.ts:141,162,187,…` assert only `result.where).toBeDefined()` for
  the critical policy→SQL compilation.

**Change.** Either strengthen the assertion (assert the compiled clause / resolved model /
mapped args) so the test can fail on regression, or delete it if a stronger test elsewhere
already covers the behavior. `agents.test.ts` (re-export) can be deleted outright.

**Acceptance criteria.** Every retained test has an assertion that can fail if the behavior
regresses; `toBeDefined()`-only tests for non-trivial logic are strengthened or removed.

**Effort:** M.

---

### P2-3 — Tighten loose multi-status assertions

**Problem.** `expect([403, 404]).toContain(res.status)` (tools.test.ts:200-292,
orchestrations.test.ts:440,500) and `expect(res.status).not.toBe(400)` soft checks
(agents.test.ts:1210,1244,…) can mask a 403→404 regression or similar.

**Change.** Pin the expected status where the behavior is deterministic. Keep the range only
where the outcome legitimately depends on scheduling/AI and document why.

**Acceptance criteria.** Each remaining multi-status/`not.toBe` assertion has a one-line
comment justifying the nondeterminism.

**Effort:** S.

---

### P2-4 — Extract the bootstrap `beforeAll` into a shared fixture helper

**Problem.** The ~40-line bootstrap→user→project→policy→noPerm sequence is copy-pasted
across ~12 REST files (e.g. `aiProviders.test.ts:13-75`, `secrets.test.ts:12-65`,
`memories.test.ts:12-70`, `chats.test.ts:15-78`, `files.test.ts:17-66`).

**Change.** Add a helper (e.g. `tests/unit/fixtures/bootstrap.ts` exporting
`setupProjectWithUsers()`) returning `{ adminToken, userToken, noPermToken, projectId, userId }`.
Migrate files incrementally. Update `.claude/rules/tests.md` to reference it.

**Acceptance criteria.**
- Helper exists with a test-driving comment.
- At least the ~12 duplicating files migrated; net line reduction reported.
- No behavior change (same tests pass).

**Effort:** M.

---

### P2-5 — Reduce order-dependence and mega-tests

**Problem.**
- `rest/mcp.test.ts` is one long chain of shared `let fileId/actorId/...` assigned in one
  test and consumed by the next; a single test cannot run in isolation.
- `permissionsFlow.test.ts:1231-1267,1374-1417` and `formationsResourceHandlers.test.ts:65-299`
  pack many operations into one `test`, obscuring which step regressed.

**Change.** Where cheap, create per-test fixtures instead of threading shared ids. Split the
largest mega-tests into per-operation cases sharing a `beforeAll`-created resource.

**Acceptance criteria.** Targeted files pass when a single test is run via
`--testNamePattern`; no mega-test spans more than one logical operation without a documented
reason.

**Effort:** M.

---

## 5. Rollout

Independent, incrementally shippable PRs. Suggested order:

1. **PR-1 (P0):** P0-1 + P0-2 — fix and audit vacuous assertions.
2. **PR-2 (P1 coverage):** P1-1 + P1-2 — actors/documents/files/chats 403 coverage.
3. **PR-3 (P1 reliability):** P1-4 + P1-5 + P1-6 — de-flake webhookDispatcher, eventBus
   leak, TTL/settling sleeps.
4. **PR-4 (P1 contract):** P1-3 — error-body contract cleanup (coordinate with route owners).
5. **PR-5+ (P2):** P2-1 split per file, then P2-2/P2-3/P2-4/P2-5.

Each PR follows the repo's red/green rule from `.claude/rules/quality-assurance.md`:
demonstrate the test fails for the right reason before/without the fix, then green.

## 6. Definition of Done (per PR)

- [ ] `pnpm --filter @soat/server typecheck` passes — no new `as any`/`as unknown`.
- [ ] `pnpm --filter @soat/server eslint --fix` passes.
- [ ] `pnpm --filter @soat/server test --testPathPatterns=<changed>` passes locally;
      full suite green in CI (`build-and-test`).
- [ ] Changed tests demonstrated to fail against the pre-fix behavior (red/green).
- [ ] No `.skip`/`.only` left; no fixed-sleep reintroduced.

## 7. Success Metrics

- 0 vacuous (always-passing) assertions in `rest/`.
- Every REST route: happy path + 401 + 403 + relevant edge covered.
- 0 `jest.doMock`/`jest.mock` of internal `app.ts`-chain modules (documented exceptions aside).
- `as any`/`as unknown` in tests reduced from ~125 toward the `formations`/`formation-modules`
  cluster being the only (documented) residual.
- Suite passes under randomized order; no fixed real-time settling sleeps.
</content>
</invoke>
