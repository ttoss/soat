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
- Cover only what tutorials do not: a module no tutorial reaches, and what only
  the full stack shows (MCP tools over HTTP, SSE streaming, model-route
  failover, idempotent retries, prompt caching). A step a tutorial already
  runs belongs to the tutorial; a new module gets a tutorial, else a smoke
  step.
- `tests/docker-compose.smoke.yml` carries every env var the server needs
  (`SECRETS_ENCRYPTION_KEY` = 64 hex chars, fixed test value); add new ones
  with the feature.
- Project keys need the caller added via `POST /projects/:id/members` first.
- LLM steps: assert structure/status only, poll `running` with a bounded
  loop, wrap stallable flows in a timeout; `requires_action` flow submits a
  synthetic result to `tool-outputs` then asserts `completed`.
- The job is not sharded (fixed cost ~4 min; Ollama ~30%, the ~800 CLI calls
  the rest). To speed it up, in order: cut CLI invocations, cut fixed
  overhead, bound or reduce generations. `MAX_COMPLETION_TOKENS` on the proxy
  caps output at 256.
- Compare smoke or tutorials timings only between runs on the same Ollama
  backend (logged: `libggml-cpu-icelake`, `libggml-cpu-haswell`; LLM steps run
  ~2× slower on Haswell).

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
CI runs a two-shard matrix, each shard with its own stack and Ollama. Harness
tests: `tests/harness/` (`pnpm run test:harness`); annotation changes need a
test there first.

Put annotations on their own line immediately **before** the command (inline or
after is silently wrong):

| Annotation | Meaning |
|---|---|
| `# → 403` / `# → expect-fail` | must exit non-zero |
| `# → ignore` | ignore exit code |
| `# → retry N` | retry until 0, up to N, 1s apart (~N × 1.3s wall clock) |

- Use `retry` only for slow-to-converge steps (webhook delivery, queued jobs,
  ingestion); budget ~3× the slowest observed run.
- Never use it to paper over a model's choice: make the step deterministic or
  add the tutorial to `.tutorialsignore` with a reason.

### Deterministic model behavior

Smoke and tutorials route Ollama through `tests/mocks/ollamaToolChoiceProxy.mjs`
(`OLLAMA_BASE_URL: http://ollama-tool-choice:11434`), which implements
`tool_choice` (Ollama drops it) for tools in `TOOL_CHOICE_TOOLS`
(`get_order_status` in tutorials, `get_weather` in smoke) and forwards
everything else verbatim. A forced allowlisted tool absent from `tools` is
answered `400`.

- Add a tool only when the assertion is about pause/dispatch wiring, not
  argument quality.
- A provider pinning `base_url` bypasses the shim; `smoke-tests.sh` routes
  providers through `$OLLAMA_URL`.
- On CI-only nondeterminism, implement the missing capability at the provider
  boundary; never weaken an assertion or retry.
- Keep Ollama at one slot per model: `OLLAMA_NUM_PARALLEL` does not raise
  throughput on CPU runners, and with four slots a queued request outlasts
  undici's 300 s headers timeout (`fetch failed`).

Local: `SOAT_BASE_URL=http://localhost:5047 ./tests/tutorials-tests.sh
packages/website/docs/tutorials/permissions.md` (`VERBOSE=1` for detail);
needs `soat`, `curl`, `jq`.
