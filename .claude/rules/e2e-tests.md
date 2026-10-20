---
paths:
  - "tests/**"
  - ".github/workflows/**"
  - "packages/website/docs/tutorials/**"
---

# Smoke and Tutorials Tests

Server unit tests: `tests.md`.

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
- LLM steps: assert structure/status only, poll `running` with a bounded
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
