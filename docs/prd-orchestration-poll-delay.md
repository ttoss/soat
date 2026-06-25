# PRD: Orchestration Poll & Delay Nodes

Add a **poll** node (call a tool on an interval until a JSON Logic exit condition is met) and finish/document the **delay** node (wait a fixed duration) in the orchestration engine.

## Implementation Status

> **Status: implemented.** Decisions locked: `interval`/`duration` accept a friendly suffix form (`5s`, `30s`, `5m`, `2h`, `500ms`) **and** ISO 8601 (`PT5S`), via a shared `parseDuration`; `fail_on_timeout` defaults to `false`.

| Component | Status | Notes |
| --- | --- | --- |
| `delay` node — executor | ✅ Implemented | `executeDelayNode` blocks via `setTimeout(parseDuration(duration))` — `orchestrationNodeExecutors.ts` |
| `delay` node — type / dispatch / validation | ✅ Implemented | `'delay'` in `OrchestratorNodeType`; dispatch case in `orchestrationExecutors.ts`; `REQUIRED_NODE_FIELDS.delay = 'duration'` |
| `delay` node — OpenAPI | ✅ Implemented | `duration` property + `delay` enum value; description now covers the suffix form |
| `delay` node — docs | ✅ Done | Node-type table in `modules/orchestrations.md` now lists `delay`, `loop`, `webhook`, `sub_orchestration` (previously undocumented) |
| `delay` / `poll` — friendly duration | ✅ Implemented | Shared `parseDuration` in `orchestrationDuration.ts` accepts suffix form + ISO 8601 |
| `delay` node — dynamic duration | ❌ Not started | `duration` is a static string today; reading it from state via `input_mapping` is a deferred enhancement |
| `poll` node — type | ✅ Implemented | `'poll'` in `OrchestratorNodeType`; `interval` + `failOnTimeout` on `OrchestrationNode` |
| `poll` node — executor | ✅ Implemented | `executePollNode` in `orchestrationPollNode.ts`: `callTool` → evaluate exit condition against `{...state, response, attempt}` → wait `interval` → repeat, bounded by `maxIterations` (default 10, ceiling 1000) + 10-min wall-clock |
| `poll` node — dispatch | ✅ Implemented | `case 'poll'` in `dispatchNodeExecution` (`orchestrationExecutors.ts`) |
| `poll` node — validation | ✅ Implemented | `REQUIRED_NODE_FIELDS.poll = 'toolId'` + `pollNodeShapeIssues` branch requiring `expression` and `interval` |
| `poll` node — error code | ✅ Implemented | `ORCHESTRATION_POLL_EXHAUSTED` (422) — raised only when `fail_on_timeout` |
| `poll` node — OpenAPI / SDK / CLI | ✅ Implemented | `poll` enum value + `interval` / `fail_on_timeout`; SDK regenerated (CLI manifest unchanged — no new endpoints) |
| `poll` node — tests | ✅ Implemented | Executor unit, validation unit, REST integration (complete + timeout), smoke (validate). DB-backed suites run in CI (no local Docker) |
| `poll` node — docs | ✅ Done | Node-type table row + "Polling" Key Concepts subsection |

> **Key finding:** the **delay node already shipped** end-to-end in code — it was just undocumented (now fixed). The substantive net-new work was the **poll node**. A separate collection-iteration node, `loop`, already exists (`executeLoopNode`); it iterates a `state` collection and is **not** a condition-based polling loop, so `poll` does not overlap with it.

## Background — what already exists

The orchestration engine (`packages/server/src/lib/orchestration*.ts`) executes a directed graph of typed nodes against a shared mutable `state` object. Relevant primitives `poll` builds on:

- **11 node types** in `OrchestratorNodeType` (`orchestrations.ts:14`): `agent`, `tool`, `transform`, `knowledge`, `memory_write`, `condition`, `human`, `loop`, `delay`, `webhook`, `sub_orchestration`.
- **Tool calls** — `executeToolNode` (`orchestrationNodeExecutors.ts:109`) resolves `input_mapping` against state and calls `callTool({ projectIds, id, action, input, authHeader })` (`lib/tools.ts`). Works for `http`, `mcp`, `soat`, and `pipeline` tools.
- **JSON Logic** — `evaluateLogic(expression, context)` and `applyInputMapping(mapping, context)` (`lib/jsonLogicMapping.ts`, backed by `json-logic-engine`). Already used by `transform`, `condition`, and every node's `input_mapping`. `condition` nodes do `String(evaluateLogic(node.expression, state))` to pick a branch.
- **ISO 8601 durations** — `parseIsoDuration` (`orchestrationNodeExecutors.ts:240`) parses `PT5S`, `PT1M30S`, `P1DT2H` → ms. Currently file-private; `poll` and `delay` should share it.
- **Execution model** — `executeRunLoop` (`orchestrationEngine.ts:184`) runs node batches **synchronously inside the originating HTTP request**. There is **no background job queue / scheduler**. `delay` already blocks the request for its duration; `poll` will block the same way. Per-node activation is capped at `MAX_ITERATIONS = 100`; cycle detection is skipped only when a `loop` node is present.

## Implementation Phases

### Phase 1 — Document & verify the delay node (small)

**Goal:** Close the gap between shipped `delay` code and its (missing) docs/tests so the node pair is coherent.

**Deliverables:**

- Add `delay` to the node-type table in `packages/website/docs/modules/orchestrations.md` — and, while there, the other undocumented shipped types (`loop`, `webhook`, `sub_orchestration`) so the table matches the enum.
- Confirm/add `executeDelayNode` unit coverage in `tests/unit/tests/lib/orchestrationNodeExecutors.test.ts` (happy path + missing-`duration` error).
- No code change to the executor required.

**Unlocks:** A documented, test-covered `delay` node; an accurate node-type reference for the `poll` work that follows.

---

### Phase 2 — Poll node (core)

**Goal:** A self-contained node that polls a tool until a JSON Logic condition on the response is satisfied, then exits — bounded by a max attempt count and a hard wall-clock ceiling.

**Deliverables:**

- `'poll'` added to `OrchestratorNodeType`; `interval?: string` and `failOnTimeout?: boolean` added to `OrchestrationNode` (reusing existing `toolId`, `operationId`, `inputMapping`, `expression`, `maxIterations`, `outputMapping`).
- `executePollNode` in `orchestrationNodeExecutors.ts` (algorithm below); `parseIsoDuration` extracted to a shared helper used by both `delay` and `poll`.
- Dispatch `case 'poll'` in `orchestrationExecutors.ts`.
- Dedicated poll validation branch in `validateNodeShape` (requires `toolId`, `expression`, `interval`).
- OpenAPI: `poll` enum value + `interval` / `fail_on_timeout` properties documented; `pnpm --filter @soat/sdk generate` and `pnpm --filter @soat/cli generate` re-run.
- Tests: executor unit tests, validation tests, REST integration test (create + run an orchestration containing a poll node), MCP test if orchestration node creation is covered there, and a smoke-test step.
- Docs: node-type table row + a "Polling" Key Concepts subsection.

**Unlocks:** "Wait for an external job/resource to reach a state" patterns — submit-then-poll APIs, async LLM/render jobs, provisioning, webhooks that aren't available — without an external scheduler.

---

### Phase 3 — Optional enhancements (out of scope for v1)

- **Dynamic delay/interval** — let `duration` / `interval` be resolved from state via `input_mapping` (e.g. exponential backoff computed by an upstream `transform`).
- **Async (non-blocking) polling** — pause the run (`requires_action`) and resume on a timer instead of blocking the HTTP request. Requires a scheduler/job queue that does not exist yet; tracked as a separate platform effort (see [Risks](#risks--limitations)).

## Overview

A `poll` node repeatedly invokes a SOAT [Tool](../packages/website/docs/modules/tools.md) and, after each call, evaluates a [JSON Logic](https://jsonlogic.com) **exit condition** against the tool's response. When the condition is truthy the node completes; otherwise it waits `interval` and tries again, up to `maxIterations` attempts. It is the condition-based counterpart to the existing collection-iteration `loop` node.

A `delay` node simply waits for a fixed ISO 8601 `duration` and completes. It already exists; this PRD documents it and pairs it with `poll`.

> See the [Permissions Reference](../packages/website/docs/modules/permissions.md) for the IAM action strings for this module. No new permission actions are required — `poll`/`delay` are node *types* inside an orchestration graph, governed by the existing `orchestrations:CreateOrchestration` / `orchestrations:StartRun` actions.

## Key Concepts

### Poll node

A `poll` node reuses the `tool` node's fields plus a polling cadence:

| Field | Source | Required | Purpose |
| --- | --- | --- | --- |
| `tool_id` | reused | ✅ | Tool to call each attempt |
| `operation_id` | reused | – | Action for MCP/SOAT tools |
| `input_mapping` | reused | – | Tool input, JSON Logic against state |
| `expression` | reused | ✅ | JSON Logic **exit condition**; truthy → stop polling |
| `interval` | **new** | ✅ | ISO 8601 wait between attempts (e.g. `PT5S`) |
| `max_iterations` | reused | – | Max attempts (default `10`, hard ceiling `1000`) |
| `fail_on_timeout` | **new** | – | On exhaustion: `true` → fail the run; `false` (default) → complete with `condition_met: false` |
| `output_mapping` | reused | – | Map the result artifact into state |

**Exit-condition context.** Unlike `transform`/`condition` (which evaluate against `state` directly), the poll exit condition is evaluated against an **augmented context**:

```js
{ ...state, response: <latest tool result>, attempt: <1-based count> }
```

So the condition reads the live response, e.g. stop when an external job reports `completed`:

```json
"expression": { "==": [{ "var": "response.status" }, "completed"] }
```

**Result artifact.** On completion the node produces:

```json
{ "result": <latest response>, "attempts": 3, "condition_met": true, "timed_out": false }
```

Downstream nodes consume it via `output_mapping`, e.g. `{ "result": "state.job", "condition_met": "state.jobDone" }`, then branch on `state.jobDone` with a `condition` node.

**Execution algorithm (`executePollNode`):**

```text
attempt      = 0
maxAttempts  = clamp(node.maxIterations ?? 10, 1, 1000)
intervalMs   = parseIsoDuration(node.interval)
deadline     = now + MAX_POLL_WALL_CLOCK            // hard ceiling, e.g. 10 min
loop:
  attempt += 1
  inputs        = applyInputMapping(node.inputMapping, state)
  lastResponse  = await callTool({ projectIds, id: toolId, action: operationId, input: inputs, authHeader })
  context       = { ...state, response: lastResponse, attempt }
  if truthy(evaluateLogic(node.expression, context)):
      return artifact { result: lastResponse, attempts: attempt, condition_met: true,  timed_out: false }
  if attempt >= maxAttempts OR now >= deadline:
      if node.failOnTimeout: throw DomainError('ORCHESTRATION_POLL_EXHAUSTED', …)
      return     artifact { result: lastResponse, attempts: attempt, condition_met: false, timed_out: true }
  await sleep(intervalMs)
```

The tool is called **before** the wait, and the wait is skipped on the final/successful attempt.

### Why a dedicated node (not a tool→condition→delay cycle)

Polling *could* be modelled as a back-edge cycle (`tool → condition → delay → tool`). A dedicated node is strongly preferred:

- The engine only tolerates graph cycles when a `loop` node exists and caps every node at `MAX_ITERATIONS = 100`; hand-built poll cycles are fragile and couple authors to engine internals.
- A `poll` node is **self-contained** — it introduces no graph cycle, so cycle detection and validation are unchanged.
- It matches the user's mental model ("a node that polls") and is far less error-prone to author (one node vs. three nodes + a back-edge + branch labels).

### Delay node

`delay` waits for a fixed `duration` (ISO 8601, e.g. `PT30S`) and completes with `{ "waited": "PT30S" }`. Already implemented (`executeDelayNode`); this PRD only adds its missing documentation.

## Node Schema (OpenAPI additions)

In `packages/server/src/rest/openapi/v1/orchestrations.yaml`, `OrchestrationNode`:

1. Add `poll` to the `type` enum (after `delay`).
2. Add properties:

```yaml
        interval:
          type: string
          description: For poll nodes — ISO 8601 wait between attempts (e.g. PT5S).
        fail_on_timeout:
          type: boolean
          description: >
            For poll nodes — when max_iterations is reached without the exit
            condition becoming true, fail the run (true) instead of completing
            with condition_met=false (default).
```

3. Clarify in the existing field descriptions that `tool_id`, `operation_id`, `input_mapping`, `expression`, and `max_iterations` are also used by `poll` nodes (`expression` = the exit condition; `max_iterations` = max attempts, default 10).

Regenerate downstream artifacts after editing the spec:

```bash
pnpm --filter @soat/sdk generate
pnpm --filter @soat/cli generate
```

The MCP tool surface for `create-orchestration` / `update-orchestration` updates automatically (derived from the OpenAPI spec at runtime via `soatTools.ts`).

## Validation

`poll` needs **three** required fields, but `REQUIRED_NODE_FIELDS` (`orchestrationValidation.ts:111`) maps each type to a *single* field. Approach:

- Set `poll: 'toolId'` in `REQUIRED_NODE_FIELDS` (primary field).
- Add a `poll`-specific branch in `validateNodeShape` (mirroring the existing `tool`-node special case at `orchestrationValidation.ts:151`) that also requires `expression` and `interval`, emitting a clear per-field message when missing.

No change to cycle detection or reachability analysis — `poll` is a normal acyclic node whose `input_mapping`/`expression` `{var:…}` refs are validated by the existing reachability pass.

## Scope — files to touch

| Surface | File | Change |
| --- | --- | --- |
| Type | `packages/server/src/lib/orchestrations.ts` | Add `'poll'` to union; add `interval`, `failOnTimeout` fields |
| Executor | `packages/server/src/lib/orchestrationNodeExecutors.ts` | Add `executePollNode`; extract shared `parseIsoDuration` |
| Dispatch | `packages/server/src/lib/orchestrationExecutors.ts` | Import + `case 'poll'` |
| Validation | `packages/server/src/lib/orchestrationValidation.ts` | `poll` entry + multi-field branch |
| Errors | `packages/server/src/errors/codes.ts` | Add `ORCHESTRATION_POLL_EXHAUSTED` (used only when `fail_on_timeout`) |
| OpenAPI | `packages/server/src/rest/openapi/v1/orchestrations.yaml` | `poll` enum + `interval` / `fail_on_timeout` |
| SDK / CLI | (generated) | `pnpm --filter @soat/sdk generate`; `pnpm --filter @soat/cli generate` |
| Unit tests | `packages/server/tests/unit/tests/lib/orchestrationNodeExecutors.test.ts` | `executePollNode` + `executeDelayNode` cases |
| Validation tests | `packages/server/tests/unit/tests/lib/orchestrationValidation.test.ts` | poll required-field cases |
| REST tests | `packages/server/tests/unit/tests/rest/orchestrations.test.ts` | create + run with a poll node |
| MCP tests | `packages/server/tests/unit/tests/rest/mcp.test.ts` | extend if orchestration node creation is covered |
| Smoke | `tests/smoke-tests.sh` | add a poll-node orchestration to section 13c |
| Docs | `packages/website/docs/modules/orchestrations.md` | node-type rows (poll + the undocumented existing types) + Polling subsection |

**Not in scope / not required:** there is **no** orchestrations formation module (`formation-modules/`) and **no** orchestration node editor in `packages/app` today, so neither needs changes. No new permission actions.

## Test Plan (TDD — red first)

Per `.claude/rules/quality-assurance.md`, write the failing test before the production code.

- **Executor unit** (`lib/orchestrationNodeExecutors.test.ts`):
  - poll completes immediately when the condition is true on attempt 1 (assert `attempts: 1`, `condition_met: true`); use a `jest.spyOn(toolsModule, 'callTool')` stub returning a canned response.
  - poll loops then succeeds (stubbed `callTool` returns "pending" then "completed"); assert attempt count and that `sleep` was awaited between attempts (inject/fake the timer).
  - exhaustion with `fail_on_timeout: false` → `condition_met: false`, `timed_out: true`; with `true` → throws `ORCHESTRATION_POLL_EXHAUSTED`.
  - missing `tool_id` / `expression` / `interval` → `ORCHESTRATION_NODE_FAILED`.
  - `delay` happy path + missing-`duration` error.
- **Validation** (`lib/orchestrationValidation.test.ts`): a poll node missing each of the three required fields yields the expected issue path/message; a complete poll node validates clean.
- **REST integration** (`rest/orchestrations.test.ts`): create an orchestration with a poll node (mock `createGeneration`/external tool as needed), start a run, assert the run reaches `completed` and the poll artifact shape. Cover `401` and `403`.
- **Smoke** (`tests/smoke-tests.sh`): via `$SOAT_CLI`, create an orchestration whose poll node calls a deterministic tool and exits on the first attempt; assert run `status == "completed"`. Keep it bounded (low `max_iterations`, short `interval`) and POSIX `sh`-compatible.

**Definition of Done:** `pnpm typecheck`, `pnpm eslint --fix`, `pnpm test`, and `pnpm run -w smoke-tests` all green; no `as any` / `as unknown`; no `console.log`.

## Risks & Limitations

- **Blocking execution (primary risk).** `poll` (like `delay`) runs inside the synchronous run loop and holds the originating HTTP request open for the whole poll. A poll of `max_iterations × interval` plus per-call tool latency can hold a connection for minutes. **Mitigations:** conservative default `max_iterations = 10`, a hard `MAX_POLL_WALL_CLOCK` ceiling enforced in the executor, and documenting that poll is for short, bounded waits. True async resumption (pause + timer-driven resume) is deferred to Phase 3 and depends on introducing a scheduler/job queue (none exists today; the `requires_action`/resume mechanism has no timer to wake it).
- **Tool side effects.** Each attempt re-invokes the tool; authors must ensure the polled operation is safe to repeat (idempotent reads, not re-submissions). Documented in the Polling subsection.
- **Field reuse of `expression`.** `transform`/`condition` evaluate against `state`; `poll` evaluates against `{...state, response, attempt}`. The augmented context is poll-specific — must be called out clearly in docs to avoid confusion.

## Resolved Decisions

1. **`interval` is a distinct field** (not a reuse of `duration`) — self-documenting per-attempt cadence.
2. **Friendly duration format.** Both `interval` and `duration` accept a suffix form (`5s`, `30s`, `5m`, `2h`, `500ms`) **and** ISO 8601 (`PT5S`), via a single shared `parseDuration`. Bare integers are intentionally rejected (unit ambiguity).
3. **`fail_on_timeout` defaults to `false`** — on exhaustion the node completes with `condition_met: false` so authors branch with a downstream `condition` node; set `true` for a hard run failure.
4. **`MAX_POLL_WALL_CLOCK` = 10 minutes** — a fixed safety ceiling in the executor.
5. **`delay` is documentation-only** for v1; dynamic (state-driven) duration remains a deferred enhancement.
