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

### Guiding policy — where the test boundary lives

The structural theme behind the P2 items is a single decision rule, now codified in
`.claude/rules/tests.md` ("Where the Test Boundary Lives" + "Mocking Philosophy — Never
Mock What You Own"):

> **Test through the entry point (REST / MCP / scheduler / event flow) by default. Write
> a direct `lib/` test only when the function is (a) a pure algorithm with a large input
> space that is expensive or low-resolution through HTTP, or (b) has no entry point. In
> any retained `lib/` test, mock only external I/O you don't own — never the DB, never a
> module you own — and prefer local fake servers over mocks.**

This is not a rewrite of the infrastructure; the suite is already ~90% boundary-tested
and does that well. It is a **prune + one enforced rule** applied to the `lib/` folder,
which today mixes genuinely-justified tests with redundant and mock-fiction ones.
Appendix A maps every current `lib/` file to keep / delete / rewrite.

## 2. Goals

- Eliminate tests that pass regardless of behavior (false confidence).
- Close authorization-coverage gaps (every route: happy path + 401 + 403 + edge).
- Remove flakiness sources (fixed real-time sleeps, leaked global listeners).
- Apply the boundary policy to `lib/`: keep the pure-algorithm / no-entry-point tests,
  delete the redundant ones, and rewrite the internal-mock cluster onto the real DB (or
  move it to the entry point).
- Reduce brittleness (exact-string error bodies) and boilerplate (copy-pasted setup).

## 3. Non-Goals

- Rewriting the testcontainer/bootstrap infrastructure.
- Changing production error shapes purely for test convenience (except where a route
  demonstrably violates the `DomainError` contract in `.claude/rules/errors.md` — see P1-3).
- Increasing raw coverage percentage as an end in itself; the aim is behavioral value.

## 4. Requirements

Priorities: **P0** = correctness of the tests themselves (a passing test is lying);
**P1** = coverage & reliability gaps; **P2** = maintainability & consistency.

Effort tags (XS/S/M/L) were sized without baseline runtime or churn metrics — treat them as
relative ordering guidance between items, not calibrated estimates.

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

### P2-1 — Apply the boundary policy to `lib/`: rewrite the internal-mock cluster

**This is the flagship structural item.** It executes the "rewrite" column of Appendix A —
the `lib/` files that violate the boundary policy by mocking things the codebase owns.

**Problem.** A cluster of `lib/` files contradicts "real Postgres, no internal mocks":
- `lib/agentGeneration.test.ts` and `lib/agentGenerationRecovery.test.ts` use
  `jest.doMock('src/db')`, `jest.doMock('src/lib/generations')`, `...eventBus`,
  `...aiProviders`, etc. + `resetModules` — on modules that **are** on the `app.ts`
  import chain, which the policy forbids. `agentGenerationRecovery` stubs *every*
  dependency, so it is fully disconnected from the real app.
- `lib/formations.test.ts` stubs `db.Formation.findOne`/`findAll` with `{ id: 1 } as any`
  throughout and duplicates `rest/formations.test.ts` coverage.
- `lib/orchestrationScheduler.test.ts` stubs `db.OrchestrationRun.*` / `db.Orchestration.*`
  even though the scheduler is a real entry point and can run against the real DB.
- `lib/formation-modules.test.ts` (~2,500 lines) and `formationsResourceHandlers.test.ts`
  `jest.spyOn` ~30–40 internal lib functions and carry the bulk of the suite's
  ~125 `as any`/`as unknown` casts.

**Change (per file, in order of value).**
1. `formations.test.ts`: delete assertions already covered by `rest/formations.test.ts`;
   convert the remainder to real-DB fixtures created via the API/models.
2. `agentGeneration*`: where the behavior is reachable through the REST generate flow,
   move it to the existing `rest/agentGeneration.test.ts` real-DB pattern with the sanctioned
   `mockCreateGeneration` spy. Keep only genuinely-internal seams as lib tests, and
   document the one tolerated `ai`-module `jest.mock` exception (`streamText`/`generateText`
   non-configurable) at the mock site (as `agentGenerationHelpers.test.ts:483-486` already does).
3. `orchestrationScheduler.test.ts`: drive the scheduler against the real DB with fake timers
   (the file already restores them cleanly); drop the `db.*` stubs.
4. `formation-modules.test.ts` / `formationsResourceHandlers.test.ts`: collapse the repetitive
   per-resource adapter assertions with `test.each`, and prefer real lib calls over spying
   every CRUD function where feasible.

**Acceptance criteria.**
- No `jest.doMock`/`jest.mock`/`jest.spyOn` that substitutes the behavior of an internal
  (`src/**`) module, except the single documented `ai`-package exception.
- No `jest.spyOn(db.*, ...)` DB-layer stubbing anywhere in `lib/`.
- `as any`/`as unknown` count in `lib/` reduced substantially (target: eliminate in
  `formations.test.ts`; document any residual).
- No net loss of behavioral coverage (entry-point counterparts assert the same properties).

**Measured end-state (2026-07-07).** Baselines for the soft targets above, taken from the repo:
`tests/unit/tests/lib/` holds **62** test files and `tests/unit/tests/rest/` **39**;
`as any`/`as unknown` stands at **97** occurrences in `lib/` and **2** in `rest/` (99 total,
down from the ~125 counted at review time). "Reduced substantially" and "where feasible" are
therefore anchored at these numbers: subsequent rewrite PRs must not regress above them, and each
Appendix A rewrite should move `lib/` further down (with `formations.test.ts` at zero).

**Effort:** L (largest item; split per-file across PRs — one file per PR is fine).

---

### P2-2 — Prune redundant and low-value `lib/` tests (the "delete" column)

Executes the "delete" column of Appendix A: `lib/` tests that neither test a pure algorithm
nor an entry-point-less function, and add no behavioral value.

**Problem.**
- `lib/agents.test.ts` re-tests `resolveUrlPathParams`, a pure re-export already covered by
  `lib/agentToolResolver.test.ts:896-951` — delete outright.
- `lib/orchestrationRunActions.test.ts` — every test hits a nonexistent run and asserts the
  same `ORCHESTRATION_RUN_NOT_FOUND`; the file comment concedes it exists only for branch
  coverage. Covered by the entry point.
- `lib/sessionTags.test.ts` / the `documents.test.ts` guard — the file comments concede the
  branch is unreachable via REST because the route pre-checks. Per the policy, delete the
  dead guard rather than test it (confirm the branch is truly unreachable first).
- `lib/agentModel.test.ts` — 17 tests assert only `toBeDefined()`; they exercise branches
  but cannot distinguish correct from incorrect wiring.
- `lib/policyCompiler.test.ts:141,162,187,…` assert only `result.where).toBeDefined()` for
  the critical policy→SQL compilation — this file is a **keep** (pure algorithm), so
  *strengthen* rather than delete: assert the compiled `where` clause structure.

**Change.** Delete the redundant/branch-only files; for the weak-assertion keeps
(`policyCompiler`, `agentModel` if kept), strengthen the assertion so the test can fail on
regression (assert the compiled clause / resolved model / mapped args).

**Acceptance criteria.** Every retained `lib/` test either exercises a pure algorithm or an
entry-point-less function *and* has an assertion that can fail on regression; redundant and
branch-only files are gone; no dead guard remains solely to be tested.

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

The guiding policy (§1) is codified in `.claude/rules/tests.md` in the same PR as this
PRD, so every subsequent PR is measured against a written rule. Then, independent,
incrementally shippable PRs in this order:

1. **PR-1 (P0):** P0-1 + P0-2 — fix and audit vacuous assertions.
2. **PR-2 (P1 coverage):** P1-1 + P1-2 — actors/documents/files/chats 403 coverage.
3. **PR-3 (P1 reliability):** P1-4 + P1-5 + P1-6 — de-flake webhookDispatcher, eventBus
   leak, TTL/settling sleeps.
4. **PR-4 (P1 contract):** P1-3 — error-body contract cleanup (coordinate with route owners).
5. **PR-5 (P2 delete):** P2-2 — delete the "delete" column of Appendix A; strengthen the
   weak-assertion keeps. Cheapest, highest signal-to-noise.
6. **PR-6+ (P2 rewrite):** P2-1 split **one file per PR** following Appendix A's rewrite
   table, then P2-3 / P2-4 / P2-5.

Each PR follows the repo's red/green rule from `.claude/rules/quality-assurance.md`:
demonstrate the test fails for the right reason before/without the fix, then green.
For rewrite PRs, "red/green" means: confirm the entry-point (or real-DB) test fails when
the production behavior is broken — proving it isn't just re-asserting a mock.

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
- 0 `jest.doMock`/`jest.mock`/`jest.spyOn` substituting an internal (`src/**`) module,
  and 0 `jest.spyOn(db.*)` DB stubs — the single documented `ai`-package mock aside.
- Every retained `lib/` file satisfies the keep-list rule (pure algorithm or no entry point).
- `as any`/`as unknown` in tests reduced from ~125 toward zero in the `formations` cluster
  (measured 2026-07-07: 99 total — 97 in `lib/`, 2 in `rest/`).
- Suite passes under randomized order; no fixed real-time settling sleeps.

## Appendix A — `lib/` file disposition under the boundary policy

Every current `lib/` test file, sorted into **keep** (satisfies the keep-list),
**delete** (redundant / branch-only / dead-guard), or **rewrite** (drop internal mocks →
real DB, or move to the entry point). Grouped; representative files named.

### Keep — pure algorithm, large input space (test directly; no mocks)

`iam`, `policyCompiler` (strengthen assertions — P2-2), `jsonLogicMapping`,
`orchestrationValidation`, `orchestrationRetry`, `formationsHelpers`, `formationsValidation`,
`soatToolsHelpers`, `filePaths`, `openapiSchemaFields`, `chunking`, `ingestionRuleMatching`,
`providerError`, `oauthConsent`, `memoryConsolidation`, `ingestionCallbackToken`,
`ingestionCallback`, `fileAuthorization`, `requestValidation`, `normalizers`,
`strictFields`, `permissionCatalog`, `openapiSpec`, `jsonLogicMapping`.

### Keep — no entry point / internal seam (real DB + external-I/O fake only)

`sessionOperations` (`sendSessionMessage` has no route), `toolsCall` (`callEphemeralTool`),
`agentToolResolver` (`execute` internals; real echo server), `discussionCompletion` and
`memoryExtractionCompletion` (**exemplary** — real `generateText` vs local stub),
`discussionEngine`, `agentKnowledge` (prompt-injection hardening), `memoryEntries`,
`memoryExtraction`, `messageContent`, `knowledge`, `agentGenerationRecordFailure`,
`agentTraces`, `fkOnDelete`, `orchestrationLease`, `orchestrationNodeExecutors`
(timer-free wait-descriptors — **exemplary**), `generationLifecycle`,
`callApi`, `pipelineTools`, `discussionsFormationModule`, `sessionTags` (keep only if a
reachable branch remains after P2-2), `generations` (record-writer half only).

### Delete — redundant / branch-only / dead guard (covered at the entry point)

| File | Reason |
|---|---|
| `agents.test.ts` | pure re-export of `resolveUrlPathParams`, already in `agentToolResolver.test.ts` |
| `orchestrationRunActions.test.ts` | every test = same `ORCHESTRATION_RUN_NOT_FOUND`; branch-coverage-only per its own comment |
| `sessionTags` / `documents` guard tests | branch unreachable via REST; delete the guard instead (verify first) |
| list/get halves of `generations` / `ingestionRules` | duplicate `rest/` coverage |

### Rewrite — drop internal mocks → real DB, or move to entry point (P2-1)

| File | Current violation | Target |
|---|---|---|
| `formations.test.ts` | `db.Formation.*` stubbed with `{id:1} as any`; dup of `rest/formations` | real-DB fixtures; delete duplicated assertions |
| `agentGeneration.test.ts` | `doMock('src/db')`, `src/lib/generations`, `eventBus` | move reachable cases to `rest/agentGeneration`; keep only internal seams |
| `agentGenerationRecovery.test.ts` | every dependency `doMock`'d — fully disconnected | real DB + `mockCreateGeneration`; keep only unreachable-via-REST recovery paths |
| `orchestrationScheduler.test.ts` | `db.OrchestrationRun.*` / `db.Orchestration.*` stubbed | real DB + fake timers (scheduler is an entry point) |
| `formation-modules.test.ts` | ~30–40 internal `spyOn`; bulk of `as any` | `test.each` + real lib calls where feasible |
| `formationsResourceHandlers.test.ts` | internal `spyOn` + mega-tests | real calls; split mega-tests (P2-5) |
| `webhookDispatcher.test.ts` | `db.WebhookDelivery.create` reject stub + fixed sleeps | real DB + promise signaling (also P1-4) |
| `eventBus.test.ts` | leaked singleton listener | register/unregister in lifecycle (also P1-5) |

> Note: `agentGenerationHelpers.test.ts` and `agentNonStreamGeneration.test.ts` mock only
> the external `ai` package (`streamText`/`generateText` are non-configurable) — that is the
> one sanctioned `jest.mock` exception, kept and documented at the mock site, not rewritten.
