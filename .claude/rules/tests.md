# Test Instructions

## Running Tests

Running the **entire** suite locally (`pnpm --filter @soat/server test` with no pattern) starts a Postgres testcontainer and runs every integration test — this is slow and should not be your default while iterating.

**Preferred local workflow:** run only the test file(s) relevant to the module you're changing, using `--testPathPatterns` (plural), then push and let GitHub Actions run the full suite (the `server-tests` shard matrix) against the complete matrix:

```bash
pnpm --filter @soat/server test --testPathPatterns=users.test.ts
```

Multiple files can be matched with a regex-style alternation:

```bash
pnpm --filter @soat/server test --testPathPatterns="projects.test.ts|agents.test.ts"
```

Only fall back to running the full local suite (`pnpm --filter @soat/server test`) when you need to sanity-check a change that plausibly affects many modules (e.g. a shared model, migration, or middleware) before pushing — do not run it as a matter of course for every change.

### How the suite gets its database

`globalSetup` starts **one** PostgreSQL for the whole run and builds the schema
once, into a database (`soat_test_template`) that no test ever connects to.
Each test file's `beforeAll` then clones it — `CREATE DATABASE ... TEMPLATE` —
and drops the clone in `afterAll`.

Every file still gets a private, pristine database, exactly as when each one
started its own container; it just costs tens of milliseconds instead of a
container start plus a schema `sync()`. Nothing about writing a test changes:
set up state through the API in `beforeAll` as before.

Two consequences worth knowing:

- **Never connect to the template.** PostgreSQL refuses to clone a database
  that has a session attached, so a stray connection to `soat_test_template`
  would fail every test file that starts afterwards.
- **`TEST_DB_HOST` reuses a running server** instead of starting a container
  (handy when Docker isn't available). The account it names needs `CREATEDB`,
  since the run creates a database per test file:

  ```bash
  TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5432 \
    TEST_DB_USERNAME=postgres TEST_DB_PASSWORD=postgres \
    pnpm --filter @soat/server test
  ```

### How CI runs it

The server suite runs as a 4-way shard matrix (`server-tests` in `pr.yml`), one
`jest --shard=N/4` per job. Because no shard sees the whole source tree, the
shards run with `--coverageThreshold={}` and upload raw coverage; the
`server-coverage` job merges the four reports and enforces the thresholds once
over the union, via `scripts/mergeCoverage.mjs`.

That script reads the thresholds from `jest --showConfig`, so
`tests/unit/jest.config.ts` stays the only place they are defined. Its
replication of Jest's grouping rules is pinned by
`tests/harness/mergeCoverage.test.mjs` (`pnpm run test:harness`) — change one
and the other must follow.

To raise or lower the shard count, edit `matrix.shard` in `pr.yml`; the job
reads `strategy.job-total` for the denominator, so the list is the only thing
to change.

## Test File Location and Naming

- Server unit tests live in `packages/server/tests/unit/tests/`
- Tests are divided into two sub-folders:
  - `rest/` — tests that call the REST API via supertest (e.g., `rest/projects.test.ts`). **This is the default.** These cover HTTP concerns: status codes, response shapes, authentication, and authorization.
  - `lib/` — tests that call lib functions directly (e.g., `lib/iam.test.ts`). Allowed **only** under the keep-list rule below.
- Test file name must match the module: `<module>.test.ts` (e.g., `projects.test.ts`)
- Every REST route must have at least one test. A public lib function is covered either through the entry point that reaches it, or — if it qualifies under the keep-list — by a direct `lib/` test.

## Where the Test Boundary Lives

Test through the **entry point** by default (REST via supertest, the MCP endpoint, the
orchestration scheduler, or the event/async flow that triggers the code). The entry
point is the contract: testing there is refactor-proof — internals can be restructured
freely without touching the test. Because the MCP tool surface is auto-derived from the
OpenAPI specs and shares handlers with REST, a REST handler test largely covers the MCP
surface too.

Write a direct **`lib/` test only** when one of these is true:

1. **Pure algorithm with a large input space** that is expensive or low-resolution to
   drive through HTTP — e.g. policy evaluation (`iam`), policy→SQL compilation
   (`policyCompiler`), graph/DAG validation (`orchestrationValidation`), expression and
   dependency resolution (`formationsHelpers`), `chunking`, `ingestionRuleMatching`.
   Reaching a single branch of these through REST would require constructing a full
   project + policy + user + resource per case, and the failure signal (a bare `403`)
   hides which branch fired.
2. **No entry point exists** — the function cannot be reached from REST, MCP, the
   scheduler, or an event (e.g. `sessionOperations.sendSessionMessage`, trace/generation
   record writers, `agentToolResolver` `execute` internals, internal async seams).

If neither holds, **do not** add a `lib/` test — cover the behavior through the entry
point. In particular:

- **Do not** write a `lib/` test that duplicates coverage a `rest/` test already provides
  (list/get/CRUD reachable through the API, re-exported functions).
- **Do not** write a `lib/` test purely to cover a defensive branch that no entry point
  can reach. If a branch is unreachable through every entry point, it is dead code —
  delete the guard instead of testing it.

### Keep-list decision, at a glance

| Situation | Where to test |
|---|---|
| CRUD / auth / lifecycle reachable through a route | `rest/` (or MCP / scheduler) |
| Pure algorithm, large input space, security- or correctness-critical | `lib/` (direct) |
| Function has no entry point at all | `lib/` (real DB + external-I/O fake only) |
| Behavior already covered by a `rest/` test | nowhere new — reuse the `rest/` test |
| Defensive branch no entry point can reach | delete the branch; don't test it |

## Test Infrastructure

Tests are integration tests that run against `app.callback()` via supertest. A real PostgreSQL instance is spun up via testcontainers in `globalSetup.ts` — once for the whole run — and each test file clones a pristine database from it in `setupTestsAfterEnv.ts` (see [How the suite gets its database](#how-the-suite-gets-its-database)). No mocking of the database layer is needed.

## Mocking Philosophy — Never Mock What You Own

The dividing line is ownership, not convenience:

- **Never mock anything you own** — the database, or any `src/**` module (lib functions,
  handlers, the event bus, the DB layer). The real PostgreSQL testcontainer exists
  precisely so you don't have to. A test that mocks the DB or an internal module tests a
  **fiction**: it can pass while the real wiring is broken, and it duplicates coverage a
  real-DB test already provides. This applies to `jest.mock`, `jest.doMock`, and
  `jest.spyOn` alike — spying on an internal module to fake its return value is still
  mocking something you own.
- **Only mock external I/O you don't own and can't run in CI** — LLM/AI model calls
  (`createGeneration`), embeddings, outbound HTTP, email. Even here, **prefer a local fake
  server over a mock** where practical: `memoryConsolidationCompletion.test.ts` and
  `memoryExtractionCompletion.test.ts` run the real `generateText` against a local
  `createServer` OpenAI-compatible stub and assert the outgoing request body — that
  exercises real serialization, which a mock skips.

**Keep mocks to the absolute minimum.** Excessive mocking makes tests brittle, hard to read, and easy to write incorrectly (the mock may not reflect real behavior).

### Rules

1. **Never mock the database.** Use the real PostgreSQL container. Set up state by calling the REST API in `beforeAll` / `beforeEach` — the same way a real client would.

2. **Never mock an internal (`src/**`) module.** No `jest.mock`, `jest.doMock`, or
   `jest.spyOn` of your own lib/handler/db modules to substitute their behavior. If you
   feel you need to, the code is either reachable through an entry point (test it there)
   or a pure function (test it directly with real inputs). The **only** sanctioned
   internal spy is `mockCreateGeneration` from `setupTestsAfterEnv.ts`, which stands in
   for the external LLM boundary.

3. **Only mock external I/O that cannot run in CI**: AI model calls (`createGeneration`), external HTTP services, email providers. Use the shared spy `mockCreateGeneration` from `setupTestsAfterEnv.ts`, or a local fake server, for this. The one tolerated exception to "no `jest.mock`" is the `ai` package (`streamText`/`generateText` exports are non-configurable, so `spyOn` cannot wrap them) — document it inline at the mock site.

4. **Prefer `jest.spyOn` over `jest.mock`.** `jest.mock` with a factory creates a new object that is invisible to modules already loaded by `app.ts`. `jest.spyOn` mutates the live export, which all modules share.

5. **Do not use `jest.doMock` + `jest.resetModules()` in REST tests.** That pattern is only appropriate for testing pure lib functions that are not transitively imported by `app.ts`. For everything else, use `jest.spyOn`.

6. **Set up DB state through the API, not through mocks.** If a test needs a conversation with specific messages, call `POST /api/v1/conversations` and `POST /api/v1/conversations/:id/messages` in `beforeAll`. The assertion then calls the endpoint under test with real data.

### Sanctioned exceptions to "never mock internal code"

Two narrow cases are allowed, each documented inline at the mock site:

1. **The `ai` package** (`streamText` / `generateText`) — non-configurable exports that
   `jest.spyOn` cannot wrap, so `jest.mock` / `jest.doMock` is used. It is an external
   dependency, not code you own (`agentNonStreamGeneration.test.ts`,
   `agentGenerationHelpers.test.ts`).
2. **Force-failure stubs for `.catch()` resilience branches.** When a lib function fires
   a write fire-and-forget behind a `.catch()` (e.g. `saveTrace` /
   `updateGenerationRecord` in `agentGenerationHelpers`), the swallow branch can only be
   exercised by making that write **reject** — and no real DB write fails
   deterministically. A minimal `jest.spyOn(...).mockRejectedValueOnce(...)` is permitted
   **solely** to drive that branch; the happy path must still run against the real DB, and
   deleting the test instead would drop branch coverage below the enforced threshold.

Everything else internal: no mocks — reach it through an entry point, or test the pure
function directly with real inputs.

### Correct pattern (integration test with minimal mock)

```ts
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

describe('POST /api/v1/conversations/:id/generate', () => {
  let convId: string;

  beforeAll(async () => {
    // Set up real DB state via the API
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    convId = res.body.id;

    await authenticatedTestClient(userToken)
      .post(`/api/v1/conversations/${convId}/messages`)
      .send({ role: 'user', message: 'Hello' });
  });

  afterEach(() => {
    jest.clearAllMocks(); // reset call counts; do NOT call restoreAllMocks
  });

  test('stores tool-call responseMessages in metadata', async () => {
    mockCreateGeneration.mockResolvedValueOnce({
      id: 'gen_1', traceId: 'trc_1', status: 'completed',
      output: { model: 'gpt-4o', content: 'Done.', finishReason: 'stop',
        responseMessages: [toolCallMsg, toolResultMsg, finalTextMsg] },
    });

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/conversations/${convId}/generate`)
      .send({ agent_id: agentId });

    expect(res.status).toBe(200);
  });
});
```

### Wrong pattern (too many mocks)

```ts
// ❌ — mocks the DB, eventBus, and agents — breaks easily and hides real behavior
jest.doMock('src/db', () => ({ db: { Conversation: { findOne: jest.fn()... } } }));
jest.doMock('src/lib/agents', () => ({ createGeneration: jest.fn()... }));
jest.doMock('src/lib/eventBus', () => ({ emitEvent: jest.fn()... }));
```

### Helpers (from `tests/unit/testClient.ts`)

- `testClient` — unauthenticated supertest client
- `authenticatedTestClient(token)` — returns a client that sets `Authorization: Bearer <token>` on every request
- `loginAs(username, password)` — bootstrap helper that logs in and returns the token string

For API key authentication, pass the raw `sk_`-prefixed key directly to `authenticatedTestClient`.

### Shared bootstrap fixture (from `tests/unit/fixtures/bootstrap.ts`)

Most REST test files need the same admin→user→project→policy→noPerm sequence in
`beforeAll`. Use `setupProjectWithUsers()` instead of writing it out by hand:

```ts
import { setupProjectWithUsers } from '../../fixtures/bootstrap';

const setup = await setupProjectWithUsers({
  prefix: 'secrets', // keeps usernames/project names unique per test file
  policyActions: ['secrets:ListSecrets', 'secrets:GetSecret', ...],
  createOtherProject: true, // opt-in: adds `otherProjectId` for cross-project isolation tests
  createNoPermUser: true, // default true; pass false when the file has no unprivileged-user tests
});
// => { adminToken, userToken, userId, projectId, otherProjectId?, policyId, noPermToken? }
```

Module-specific tail setup (e.g. creating a secret, AI provider, or extra tool
fixtures needed only by that file) stays in the file's own `beforeAll`, called
after `setupProjectWithUsers()`.

## Writing Unit Tests

### Structure

Group tests by HTTP method and route path using nested `describe` blocks:

```ts
describe('MyModule', () => {
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'alice', password: 'alicepass' });

    userToken = await loginAs('alice', 'alicepass');
  });

  describe('GET /api/v1/resource', () => {
    test('authenticated user can list resources', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/resource');
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/resource');
      expect(response.status).toBe(401);
    });
  });
});
```

### Coverage Requirements

Every module must cover:

- Happy path for each route (correct status code and response shape)
- `401` for unauthenticated requests
- `403` for requests by users without required permission
- Edge cases specific to the business logic (e.g., API key scoping, missing resources returning `404`)

### Response Shape Assertions

Always assert the shape of the response body, not just the status code:

```ts
expect(response.body.id).toBeDefined();
expect(response.body.name).toBe('expected name');
expect(response.body.password).toBeUndefined(); // sensitive fields must be absent
```

Internal database IDs must never appear in responses — assert `id` maps to `publicId`.

Request and response bodies are **snake_case** everywhere — REST, MCP, webhooks, the
audit export — so a test names each field exactly as the OpenAPI spec does. There is no
second casing to reconcile and no middleware rewriting keys, which is why these
assertions survive refactors: they name the contract.

Whenever an assertion looks like it "can never fail," prove it can: break the production
path locally and confirm the test goes red before trusting it (red/green).

### Pin status codes

Assert the exact expected status. Avoid loose `expect([403, 404]).toContain(res.status)`
or `expect(res.status).not.toBe(400)` — they mask real regressions (e.g. a `403`→`404`
flip). Keep a range **only** when the outcome legitimately depends on scheduling or a live
LLM/provider, and add a one-line comment justifying the nondeterminism:

```ts
// Ollama isn't running in unit CI, so the call either succeeds (200) or fails
// upstream (502) — never 400, which is what this test actually verifies.
expect([200, 502]).toContain(res.status);
```

### Keep tests independent and single-purpose

A test should be runnable on its own (`--testNamePattern`). Prefer per-test fixtures over
threading a `let sharedId` assigned in one test and consumed by the next — that chain means
a single test can't run in isolation and an early failure cascades. When several operations
must share an expensive resource, create it once in `beforeAll` and give each operation its
own `test`, rather than packing many operations into one giant `test` where it's unclear
which step regressed.

## Spying on Modules Loaded at App Startup

Some lib modules (e.g., `agents.ts`, `conversations.ts`) are loaded transitively by `app.ts` during `setupFilesAfterEnv`. This happens **before** any test file executes, which means `jest.mock(...)` — even though it is hoisted by Babel — creates a _new_ mock object that is never seen by the already-loaded module. As a result, the original function is still called and the mock is silently ignored.

**Do not use `jest.mock` for modules that are transitively imported by `app.ts`.** Use `jest.spyOn` instead. `jest.spyOn` mutates a property on the _existing_ exports object, which is the same reference held by every module that imported it at startup.

### Pattern — local spy (created per test)

Create the spy inside `beforeEach` and restore it in `afterEach`. Safe to use `jest.restoreAllMocks()` because the spy is recreated on the next `beforeEach`.

```ts
import * as agentsModule from '../../../src/lib/agents';
import type { GenerationResult } from '../../../src/lib/agents';

// Inside describe block:
describe('something that pauses async work', () => {
  let resolveGeneration: (() => void) | undefined;

  beforeEach(() => {
    jest.spyOn(agentsModule, 'createGeneration').mockImplementationOnce(
      () =>
        new Promise<GenerationResult>((resolve) => {
          resolveGeneration = () =>
            resolve({
              id: 'gen_01',
              traceId: 'trc_01',
              status: 'completed',
              output: {
                model: 'test-model',
                content: 'Hello',
                finishReason: 'stop',
              },
            });
        })
    );
  });

  afterEach(() => {
    jest.restoreAllMocks(); // safe — spy is recreated in the next beforeEach
  });
});
```

### Pattern — shared spy (created in `setupTestsAfterEnv.ts`)

When a spy needs to be reused across multiple `describe` blocks (e.g., exported from `setupTestsAfterEnv.ts`), **do not call `jest.restoreAllMocks()`**. Restoring disconnects the spy from the module permanently — subsequent `mockImplementationOnce` calls queue on a dead object and the real function runs instead, causing tests to hang.

Use `jest.clearAllMocks()` instead — it resets call counts and queued implementations without unwiring the spy.

```ts
// setupTestsAfterEnv.ts
export const mockCreateGeneration = jest.spyOn(agentsModule, 'createGeneration');

// sessions.test.ts
import { mockCreateGeneration } from '../../setupTestsAfterEnv';

describe('something that pauses async work', () => {
  beforeEach(() => {
    mockCreateGeneration.mockImplementationOnce(() => new Promise(...));
  });

  afterEach(() => {
    jest.clearAllMocks(); // resets state but keeps the spy wired — do NOT use restoreAllMocks here
  });
});
```

### Key rules

- **For local spies (created in `beforeEach`)**: call `jest.restoreAllMocks()` in `afterEach`. The spy is recreated each time so restoring is safe.
- **For shared spies (exported from `setupTestsAfterEnv.ts`)**: call `jest.clearAllMocks()` in `afterEach`. `jest.restoreAllMocks()` would permanently disconnect the spy, causing all subsequent tests that rely on it to silently call the real function.
- **Never use `jest.mock(path, factory)` for a path that is transitively required by `app.ts`**. Identify such modules by tracing the import chain: `app.ts` → routers → lib modules. Any module on that chain must be spied on, not mocked.
- When the target function is used in a fire-and-forget async path (e.g., `.catch(() => {})`), poll for a side-effect (e.g., a flag set inside the mock, or a DB column change) rather than awaiting the call directly.

### Async Coordination Pitfalls

- **Supertest requests are lazy.** A request built with `.post(...).send(...)` does not reliably start server processing until it is consumed (for example with `await`, `.then(...)`, or `.end(...)`). In coordination tests, start the request first, then await your synchronization signal.
- **Prefer Promise-based signaling over timer polling.** In tests that may run alongside fake timers, avoid `setTimeout`/`setImmediate` polling loops. Use a Promise signal (for example `signalStarted` / `started`) triggered inside the mocked function to coordinate progress deterministically.
- **No fixed real-time settling sleeps.** Never `await setTimeout(300)` hoping a
  fire-and-forget path has finished — it is timing-dependent and flaky under CI load.
  Resolve a Promise inside the dispatch boundary (as `rest/sessions.test.ts` does) or poll
  a bounded predicate on the observable side effect — a delivery row, a mock call, a DB
  column change (as `generationLifecycle.test.ts` does). For TTL / expiry behavior, advance
  an injected clock rather than sleeping past the TTL.
- **Never assert across a wall-clock bucket boundary.** State keyed by a truncated
  timestamp — a quota's fixed window, a rate-limit bucket, a per-minute aggregate — resets
  the instant the key changes, and nothing in the test controls when that is. A sequence of
  requests asserting on such a counter must run against a bucket that *cannot* roll over
  mid-test: `rest/quotas.test.ts` pins every counted sequence to `calendar_month`
  (`COUNTED_WINDOW`), and `lib/quotaGenerationEnforcement.test.ts` defaults to it. With a
  minute-sized bucket the assertion holds only while every request lands in the same
  minute, so it fails a few times in a thousand runs — long after the change that
  introduced it (#1049). Cover the truncation math itself separately, against a frozen
  clock (`lib/quotas.test.ts`).
- **Never leak global singleton state.** A listener registered on a shared bus
  (`onEvent` on the `eventBus` singleton) or a mutated shared registry must be torn down in
  `finally` / `afterEach`, or it leaks into every later test and breaks the suite under
  randomized file order (`orchestrationScheduler.test.ts` shows `eventBus.off(...)` in a
  `finally`). Every test must pass both in isolation and in a randomized order.

## MCP Tool Tests

All MCP (Model Context Protocol) tools must be tested in `packages/server/tests/unit/tests/mcp.test.ts`. This is a single integration test file that covers all MCP tools across all modules.

### When to Add MCP Tests

**Every new MCP tool must have a corresponding test added to `mcp.test.ts` before the implementation is considered complete.** This includes:

- New tools added to existing modules
- New modules with MCP tools
- Modifications to existing tools that change their behavior

### Test Structure

MCP tests are organized by module with comment headers:

```ts
// ── Module Name ──────────────────────────────────────────────────────────

test('tool-name does something', async () => {
  const res = await mcpCall('tool-name', { arg: 'value' });
  expect(res.status).toBe(200);
  const result = parseResult(res);
  expect(result.id).toBeDefined();
});
```

### Test Patterns

- Use the `mcpCall` helper to invoke tools via the MCP endpoint
- Use `parseResult` to extract JSON responses
- Assert both HTTP status codes and response structure
- Follow the same coverage requirements as REST API tests (happy path, error cases)
- Mock external service responses (e.g., AI completions) to ensure tests are deterministic and fast

### Running MCP Tests

Run MCP tests specifically:

```bash
pnpm --filter @soat/server test --testPathPatterns=mcp.test.ts
```

## Smoke Tests

The smoke tests (`tests/smoke-tests.sh`) are end-to-end shell scripts that run against a live server. They require `curl` and `jq`.

### Where the time goes (and why it is not sharded)

Profiled from the 2026-08-05 CI run, the ~9.5 min job split roughly:

| Phase | Time |
|---|---|
| Job setup (checkout, free disk, Ollama image + model cache) | ~1.5 min |
| `docker compose` build | ~1 min |
| Stack startup to the first script step | ~20 s |
| `smoke-tests.sh` itself | ~5.5 min |
| Teardown + post steps | ~50 s |

**The script is Ollama-bound.** Of its ~5.5 min, Ollama accounted for ~240 s
(24 chat completions, ~219 s; 31 embeddings, ~21 s) — about 73%. The rest is the
463 `$SOAT_CLI` invocations, each a Node process start (~150 ms) plus its HTTP
round trip.

**That cost used to be extremely variable.** Nothing in SOAT bounds how many
tokens `qwen2.5:0.5b` emits (agents have no `max_tokens` field), so the same
step could take 24 s in one run and 121 s in the next; between the 2026-08-05
runs, total chat time swung 219 s → 406 s with no change to the suite. The smoke
stack now caps every forwarded chat completion at 256 output tokens via
`MAX_COMPLETION_TOKENS` on the `ollama-tool-choice` proxy service (see
`tests/docker-compose.smoke.yml`), which bounds both the total and the variance.
Still treat any single-run smoke timing as noisy; compare phases
(build / startup / script / teardown), not job totals.

> When profiling from CI logs, note that Ollama's `[GIN]` lines use Go duration
> format — `1m23s`, not `83s`. A regex that only handles `s`/`ms`/`µs` silently
> drops exactly the slow requests you are looking for, which is how an earlier
> version of this table understated Ollama by 40%.

**Do not shard this job the way `server-tests` is sharded.** The per-job fixed
cost — setup, image build, stack startup, teardown — is close to 4 minutes, so a
2-way split of a 5.5-minute script lands around 7 minutes against ~8.5 minutes
whole, while doubling runner cost and Ollama pulls. The unit suite shards well
because its fixed cost is ~40 s; this one does not.

The productive levers, in order, are: bound or reduce the LLM generations, cut
fixed overhead, then cut CLI invocations. Inference *speed* is not a lever — the
models load once (~0.55 s each, verified in the Ollama logs) and the runner is
CPU-only.

### CLI-first rule

**All operations in `smoke-tests.sh` must be performed via the `$SOAT_CLI` wrapper** (e.g. `$SOAT_CLI create-agent`, `$SOAT_CLI create-agent-session`). The only permitted exception is the MCP JSON-RPC protocol check (`POST /mcp`), which uses `curl` because the `/mcp` endpoint is not a REST API operation and has no CLI equivalent. Do **not** use `curl` to call any `/api/v1/*` endpoint — if the CLI does not yet support an operation, add it to the CLI first.

### Running

```bash
pnpm run -w smoke-tests
```

The script uses `set -e` and exits with a non-zero code on the first failure, printing which step failed.

Keep `tests/smoke-tests.sh` POSIX-compatible (`#!/bin/sh`): use `[`/`]` tests instead of Bash-only constructs like `[[ ... ]]`.

### Scope

The smoke tests must cover every module end-to-end: users, projects, project policies, project keys, secrets, files, documents, conversations, chats, AI providers, agents (HTTP tool, MCP tool, client tool, SOAT tool), and traces. Every new module must have corresponding smoke test steps added before the implementation is considered done.

### Environment Variables

`tests/docker-compose.smoke.yml` must include every environment variable that the server requires at runtime for the features under test. Missing variables cause hard startup failures. Key variables:

- `SECRETS_ENCRYPTION_KEY` — 64-character hex string (32 bytes) required by the secrets module. Use a fixed test value: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`.

Whenever a new env-dependent feature is added to the server, add the corresponding variable to the `server` service environment in `tests/docker-compose.smoke.yml` at the same time.

### Prerequisites and Ordering

Some endpoints require prior setup that is not performed automatically. Always satisfy prerequisites explicitly in the smoke script before calling the endpoint:

- **Project keys** — `POST /project-keys` requires the calling user to be a member of the project (`UserProject` row). Add the user via `POST /projects/:id/members` (expect `201`) before creating a key.
- **Secrets** — require `SECRETS_ENCRYPTION_KEY` to be set in the server environment.

### Agent and LLM Smoke Patterns

- **Do not assert LLM output content.** Only check structural/status fields (e.g., `status == "completed"`, `id` is present). LLM responses vary by model and prompt.
- **Poll for async generation.** Agent generation endpoints may return `in_progress`; retry with a loop and `--max-time` guard before asserting the final status.
- **Bound long-running LLM tool orchestration.** For MCP/agent flows that can stall, wrap calls with an explicit timeout and fail fast with a clear error.
- **Client-tool (`requires_action`) flow.** When testing client-side tool execution: assert `status == "requires_action"`, extract `requiredAction.toolCalls[0]`, submit a synthetic result to `POST /agents/:id/generate/:genId/tool-outputs`, then assert `status == "completed"`.
- **Non-fatal server errors from LLM tool calls** (e.g., `SequelizeValidationError` when the model hallucinates a bad tool argument) do not fail the smoke tests — only the smoke assertions matter.

## Tutorials Tests

Tutorial tests run CLI commands from docs tutorials in a containerized environment.

### Running

Run all enabled tutorials:

```bash
docker compose -f tests/docker-compose.tutorials.yml up --build --renew-anon-volumes --remove-orphans --abort-on-container-exit --exit-code-from tutorials
docker compose -f tests/docker-compose.tutorials.yml down --volumes
```

Run a single tutorial by name (without `.md`):

```bash
TUTORIAL_ID=permissions docker compose -f tests/docker-compose.tutorials.yml up --build --renew-anon-volumes --remove-orphans --abort-on-container-exit --exit-code-from tutorials
docker compose -f tests/docker-compose.tutorials.yml down --volumes
```

### How It Works

Tutorial discovery and execution is split across two scripts:

- **`tests/run-tutorials.sh`** — Orchestrator. Reads all `*.md` files from `/tutorials`, filters out entries listed in `tests/.tutorialsignore`, bootstraps the admin user (idempotent), then calls `tutorials-tests.sh` for each file. If `TUTORIAL_ID` is set, only the matching tutorial is run.
- **`tests/tutorials-tests.sh`** — Per-tutorial runner. Extracts and executes CLI commands from a single tutorial markdown file.

`tutorials-tests.sh` does the following:

1. Checks the target markdown file exists.
2. Ensures `SOAT_BASE_URL` is set.
3. Extracts commands only from `<TabItem value="cli">` fenced `bash` blocks.
4. Joins multiline commands and executes them in order in one shell context.
5. Supports `# → expect-fail`, `# → ignore`, and `# → retry N` command annotations.
6. Handles non-interactive profile setup by capturing `soat login-user` tokens and writing profiles for `soat configure` steps.

The runner itself is covered by `tests/harness/` (`pnpm run test:harness`, wired into
`pr.yml` and `main.yml`). Any change to annotation handling needs a test there first.

### Command Annotations

| Annotation | Meaning |
|---|---|
| `# → 403` / `# → expect-fail` | The command must exit non-zero. A zero exit fails the run. |
| `# → ignore` | Run the command, ignore its exit code entirely. |
| `# → retry N` | Re-run until the command exits 0, up to N attempts, 1s apart. Fails after N. |

**An annotation must sit on its own line, immediately _before_ the command it
applies to.** Both other placements silently fail:

```bash
# → 400
soat transition-task --task-id "$TASK_ID" --transition publish   # correct

soat transition-task --task-id "$TASK_ID" --transition publish   # → 400
# WRONG — inline, annotation ignored, step fails on the non-zero exit

soat transition-task --task-id "$TASK_ID" --transition publish
# → 400
# WRONG — binds to whichever command comes NEXT, not the one above
```

A **trailing** annotation is not recognized at all: the extractor only matches a
`#` at the start of a line, so an inline `# → …` reaches the shell as an ordinary
comment. An annotation on its own line **after** a command is equally wrong — a
command line with balanced quotes is flushed the moment it is read, so
`CURRENT_CMD` is already empty and the annotation becomes the *pending* one for
the following command.

The behavior is pinned by `tests/harness/tutorialsRetryAnnotation.test.mjs`,
where every case places the annotation on the preceding line.

`# → retry N` is for steps that are **slow to converge** — an async webhook delivery, a
queued job, an ingestion that finishes shortly after the call returns. It replaces
hand-rolled `for _ in $(seq 1 20); do … done` loops in tutorial prose, and it lets an
assertion stay *enforced* instead of being downgraded to `# → ignore`.

Do **not** use it to paper over an LLM's choices. A step whose outcome depends on what a
model decides must be made deterministic instead — see "Deterministic model behavior"
below — or the tutorial belongs in `.tutorialsignore` with a comment saying why.

### Deterministic Model Behavior

The smoke and tutorials stacks route Ollama traffic through
`tests/mocks/ollamaToolChoiceProxy.mjs` (`OLLAMA_BASE_URL: http://ollama-tool-choice:11434`).

Ollama's OpenAI-compatible endpoint does not implement `tool_choice` — it drops the field
— so an agent that forces a specific tool gets no forcing at all and the run pauses only
when the sandbox's `qwen2.5:0.5b` volunteers a tool call. That made the client-tool
assertions in both suites probabilistic, and a single flake blocked a release (#774).

The proxy implements that one missing field, for the tools named in
`TOOL_CHOICE_TOOLS` (one per stack today: `get_order_status` in tutorials, `get_weather`
in smoke), and forwards everything else — an unlisted tool, no `tool_choice`, `"auto"`,
`"none"`, embeddings, every other route — to the real Ollama verbatim. It also owns the
optional `MAX_COMPLETION_TOKENS` output cap: when set (the smoke stack sets 256), every
forwarded chat completion gets `max_tokens` injected — a caller value below the cap is
kept — because agents have no `max_tokens` field of their own and the sandbox model's
unbounded output is the dominant, highly variable cost of these jobs. A forced-tool
assertion on an allowlisted tool is therefore deterministic, and a failure is a real
regression in the pause/resume path.

The allowlist is what keeps this safe. Other flows force tools whose **arguments** only a
model can supply — the guardrail-gated tool in the smoke suite, per-step `step_rules`
forcing in the formations tutorial (document ids, the poem text) — and synthesizing those
would be worse than the status quo. Adding a tool to `TOOL_CHOICE_TOOLS` is only correct
when the assertion is about *the pause/dispatch wiring*, not about argument quality.

**The shim fails closed.** A request that forces an **allowlisted** tool it does not offer
in `tools` is answered `400`, naming the tool — it is never forwarded. That case is a
wiring break (the tool was renamed, the agent lost its binding, the request never carried
the tool list), and forwarding it would hand the outcome back to `qwen2.5:0.5b` and revive
the #774 coin flip several steps downstream, where it reads as a flaky assertion rather
than as the misconfiguration it is. Forcing a tool that is **not** allowlisted still
forwards, unchanged — that is the deliberate case above, not a break.

Every request that *asks* for forcing logs one line with what it asked for, what tools were
offered, and what the shim did (`forced` / `forwarded` / `REJECTED`); requests with no
`tool_choice` (or `"auto"` / `"none"`) stay silent. `pr.yml` and `main.yml` dump the
`ollama-tool-choice` service logs on job failure, because `docker compose up` does not
attach that service's stdout — without both halves, a downstream failure gives no way to
tell whether forcing was even requested, let alone honored.

Note the interaction with `base_url`: an AI provider that pins `base_url` overrides the
server's `OLLAMA_BASE_URL`, so it bypasses the shim. `tests/smoke-tests.sh` routes its
providers through `$OLLAMA_URL` for that reason.

When a CI-only nondeterminism appears, prefer this shape — implement the missing
capability at the provider boundary — over weakening an assertion or retrying a
generation.

### Ignoring Tutorials

Add a tutorial's base filename (without `.md`) to `tests/.tutorialsignore` to exclude it from automated runs:

```
# tests/.tutorialsignore
connect-third-party-llms
```

Lines starting with `#` and blank lines are ignored.

### Adding a New Tutorial

1. Drop the `.md` file into `packages/website/docs/tutorials/`.
2. It is automatically discovered and run — no changes to the compose file needed.
3. If it should not be run in CI (e.g., requires external services not available), add its name to `tests/.tutorialsignore`.

### Local Usage

```bash
chmod +x tests/tutorials-tests.sh
export SOAT_BASE_URL=http://localhost:5047
./tests/tutorials-tests.sh packages/website/docs/tutorials/permissions.md
```

Verbose mode:

```bash
VERBOSE=1 ./tests/tutorials-tests.sh packages/website/docs/tutorials/permissions.md
```

### Requirements

- SOAT server available at `SOAT_BASE_URL`
- `soat` CLI in `PATH`
- `curl` and `jq` available in the test container/environment

### Limitations

- Interactive manual input flows are intentionally bypassed.
- Commands are executed with `eval`; only trusted tutorial files should be executed.
