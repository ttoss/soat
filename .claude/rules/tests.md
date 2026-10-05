---
paths:
  - "packages/server/**"
  - "packages/postgresdb/**"
  - "tests/**"
  - "scripts/**"
  - ".github/workflows/**"
---

# Server Tests

## Running

Run only the files you touch; CI runs the full suite as a 4-way shard matrix
(`server-tests` in `pr.yml`, thresholds merged by `scripts/mergeCoverage.mjs`
from `tests/unit/jest.config.ts`; pinned by `tests/harness/mergeCoverage.test.mjs`).

```bash
pnpm --filter @soat/server test --testPathPatterns=users.test.ts
pnpm --filter @soat/server test --testPathPatterns="projects.test.ts|agents.test.ts"
pnpm --filter @soat/server test          # full suite; only for cross-cutting changes
```

`globalSetup` starts one Postgres, builds the schema into `soat_test_template`,
and each file clones it in `beforeAll`. Never connect to the template. Without
Docker, `TEST_DB_HOST` / `TEST_DB_PORT` / `TEST_DB_USERNAME` / `TEST_DB_PASSWORD`
reuse a server whose account has `CREATEDB`.

## Location

`packages/server/tests/unit/tests/`, one directory per class:

| Class | Drives | Example |
|---|---|---|
| `rest/<module>.test.ts` | an entry point via supertest (default) | `rest/agents.test.ts` |
| `jobs/<routine>.test.ts` | a background routine no request reaches: a scheduler tick, the queue worker's drivers, the worker healthcheck | `jobs/triggerScheduler.test.ts` |
| `lib/<module>.test.ts` | a function directly, keep-list only (below) | `lib/iam.test.ts` |

Every REST route has a test. A routine is whatever `server.ts`, `worker.ts` or
`workerHealthcheck.ts` starts, plus `lib/scheduler.ts` they all run on; a `lib/`
test importing one fails `tests/harness/serverTestLayout.test.mjs`, which also
holds the directories to these three.

## Test at the entry point

The class is decided by the stimulus, not by where the outcome is read: a
file whose tests are triggered by a tick (`wakeDueRuns`, a retention sweep,
the storage snapshot) is `jobs/`, even when it reads the outcome back through
`GET`, which it should whenever the API shows it. A tick run as one setup step
inside a test triggered by a request (wake a run, then assert its `GET`) keeps
that test in `rest/`.

Default to REST, the MCP endpoint or the event flow. Write a `lib/` test only
when:

1. a pure algorithm with a large input space is expensive or low-resolution
   through HTTP (`iam`, `policyCompiler`, `orchestrationValidation`,
   `formationsHelpers`, `chunking`, `ingestionRuleMatching`), or
2. no entry point and no routine reaches the function.

Never duplicate `rest/` coverage in `lib/` or `jobs/`, and never test a
defensive branch no entry point reaches: delete the branch.

## Never mock what you own

The DB and every `src/**` module run for real; `jest.mock`, `jest.doMock` and
`jest.spyOn` on internal modules are all mocking. Set up state through the API
in `beforeAll`. Mock only external I/O that cannot run in CI (LLM calls,
embeddings, outbound HTTP, email), preferring a local fake server (see
`memoryConsolidationCompletion.test.ts`).

Sanctioned exceptions, documented inline at the mock site:

- `mockCreateGeneration` from `setupTestsAfterEnv.ts` — the LLM boundary.
- The `ai` package (`streamText` / `generateText` are non-configurable, so
  `jest.mock` is used).
- `jest.spyOn(...).mockRejectedValueOnce(...)` solely to drive a `.catch()`
  resilience branch; the happy path still runs on the real DB.

Prefer `jest.spyOn` over `jest.mock`: modules loaded by `app.ts` in
`setupFilesAfterEnv` never see a `jest.mock` factory. `jest.doMock` +
`jest.resetModules()` only for pure lib functions `app.ts` does not import.

Local spies (created in `beforeEach`): `jest.restoreAllMocks()` in `afterEach`.
Shared spies (exported from `setupTestsAfterEnv.ts`): `jest.clearAllMocks()`
only — restoring disconnects the spy permanently and tests hang.

## Helpers

`tests/unit/testClient.ts`: `testClient`, `authenticatedTestClient(token)`
(also takes a raw `sk_` key), `loginAs(username, password)`.

`tests/unit/fixtures/bootstrap.ts`:

```ts
const setup = await setupProjectWithUsers({
  prefix: 'secrets',
  policyActions: ['secrets:ListSecrets', 'secrets:GetSecret'],
  createOtherProject: true,   // adds otherProjectId
  createNoPermUser: true,     // default
});
// { adminToken, userToken, userId, projectId, otherProjectId?, policyId, noPermToken? }
```

## Writing tests

- Nest `describe` by method and path.
- Cover happy path (status + body shape), `401`, `403`, edge cases.
- Assert the body: `id` defined, sensitive fields `toBeUndefined()`, `id` is the
  `publicId`. Fields are snake_case exactly as the spec.
- Pin exact status codes. A range is allowed only for scheduling or live-LLM
  nondeterminism, with a one-line comment.
- Each test runs alone (`--testNamePattern`): no `let sharedId` chains; shared
  expensive resources go in `beforeAll`, one operation per `test`.
- Prove a test can fail before trusting it.

## Async pitfalls

- Supertest requests are lazy; start the request before awaiting a signal.
- Signal with Promises, not timer polling. Never `await setTimeout(n)` to let a
  fire-and-forget path settle; resolve inside the dispatch boundary or poll a
  bounded predicate on a side effect. Advance an injected clock for TTLs.
- Never assert across a wall-clock bucket boundary: counted sequences
  use `calendar_month` (`COUNTED_WINDOW` in `rest/quotas.test.ts`); test
  truncation math against a frozen clock.
- Tear down global listeners (`eventBus.off`) in `finally` / `afterEach`; every
  test passes in isolation and in randomized order.

## MCP tools

All in `tests/unit/tests/rest/mcp.test.ts`, grouped by module with comment
headers; use `mcpCall` and `parseResult`; same coverage as REST. Every new or
changed tool gets a test.

## Smoke tests (`tests/smoke-tests.sh`)

- `pnpm run -w smoke-tests`; POSIX `sh` (`[ ]`, not `[[ ]]`); `set -e`.
- Every operation goes through `$SOAT_CLI`; the only `curl` is the `/mcp`
  JSON-RPC check. Missing CLI support → add it to the CLI first.
- Covers what the tutorials do not: a module no tutorial reaches, and what only
  the full stack shows (MCP tools over HTTP, SSE streaming, model-route
  failover, idempotent retries, prompt caching). A step whose commands a
  tutorial already runs belongs to the tutorial, not here; a new module gets a
  tutorial or, failing that, a smoke step.
- `tests/docker-compose.smoke.yml` carries every env var the server needs
  (`SECRETS_ENCRYPTION_KEY` = 64 hex chars, fixed test value). Add new ones
  with the feature.
- Project keys need the caller added via `POST /projects/:id/members` first.
- LLM steps: assert structure/status only, poll `in_progress` with a bounded
  loop, wrap stallable flows in a timeout; `requires_action` flow submits a
  synthetic result to `tool-outputs` then asserts `completed`.
- The job is not sharded (fixed cost ~4 min). Ollama requests are ~30% of
  script time; the rest is the ~800 CLI calls. Levers, in order: cut CLI
  invocations, cut fixed overhead, bound or reduce generations.
  `MAX_COMPLETION_TOKENS` on the proxy caps output at 256.
- Runner CPUs differ: Ollama logs its backend (`libggml-cpu-icelake`,
  `libggml-cpu-haswell`), and LLM steps run ~2× slower on Haswell. Compare
  smoke or tutorials timings only between runs on the same backend.

## Tutorials tests

```bash
docker compose -f tests/docker-compose.tutorials.yml up --build --renew-anon-volumes --remove-orphans --abort-on-container-exit --exit-code-from tutorials
TUTORIAL_ID=permissions docker compose -f tests/docker-compose.tutorials.yml up ...   # one tutorial
TUTORIAL_SHARD=1/2 docker compose -f tests/docker-compose.tutorials.yml up ...      # CI shard 1 of 2
docker compose -f tests/docker-compose.tutorials.yml down --volumes
```

`tests/run-tutorials.sh` discovers `*.md`, skips `tests/.tutorialsignore`,
bootstraps admin, and calls `tests/tutorials-tests.sh` per file, which runs
`<TabItem value="cli">` bash blocks in one shell (`eval`; trusted files only).
CI runs them as a two-shard matrix: the tutorials queue on their stack's one
Ollama, so a shard with its own stack runs its half in about half the time on
the same runner CPU. Harness tests: `tests/harness/` (`pnpm run test:harness`); annotation changes
need a test there first.

Annotations sit on their own line immediately **before** the command
(inline or after is silently wrong):

| Annotation | Meaning |
|---|---|
| `# → 403` / `# → expect-fail` | must exit non-zero |
| `# → ignore` | ignore exit code |
| `# → retry N` | retry until 0, up to N, 1s apart (~N × 1.3s wall clock) |

`retry` is for slow-to-converge steps (webhook delivery, queued jobs,
ingestion); budget ~3× the slowest observed run. Never use it to paper over a
model's choice: make the step deterministic or add the tutorial to
`.tutorialsignore` with a reason.

### Deterministic model behavior

Smoke and tutorials route Ollama through `tests/mocks/ollamaToolChoiceProxy.mjs`
(`OLLAMA_BASE_URL: http://ollama-tool-choice:11434`), which implements
`tool_choice` (Ollama drops it) for tools in `TOOL_CHOICE_TOOLS`
(`get_order_status` in tutorials, `get_weather` in smoke) and forwards
everything else verbatim. A forced allowlisted tool absent from `tools` is
answered `400`. Add a tool only when the assertion is about pause/dispatch
wiring, not argument quality. A provider pinning `base_url` bypasses the shim;
`smoke-tests.sh` routes providers through `$OLLAMA_URL`. On CI-only
nondeterminism, implement the missing capability at the provider boundary
rather than weakening an assertion or retrying.

Ollama keeps its default of one slot per model. On the CPU runners a chat
request is bound by prompt processing, so `OLLAMA_NUM_PARALLEL` does not raise
throughput, and with four slots a queued request outlasts undici's 300 s
headers timeout and the generation fails with `fetch failed`.

Local: `SOAT_BASE_URL=http://localhost:5047 ./tests/tutorials-tests.sh
packages/website/docs/tutorials/permissions.md` (`VERBOSE=1` for detail);
needs `soat`, `curl`, `jq`.
