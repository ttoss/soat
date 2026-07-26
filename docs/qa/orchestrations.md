# QA checklist — orchestrations

Module docs: [`packages/website/docs/modules/orchestrations.md`](../../packages/website/docs/modules/orchestrations.md)
Also covers the `orchestration` formation resource type (Agent Squads).
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-03 | `soat-tests` MCP project-key credential (admin, project `proj_ElQRuVqixOmM9Qva`, full-access policy), AI provider `bedrock` / `deepseek.v3.2` | 6 defects found | [#375](https://github.com/ttoss/soat/issues/375), [#376](https://github.com/ttoss/soat/issues/376), [#377](https://github.com/ttoss/soat/issues/377), [#378](https://github.com/ttoss/soat/issues/378), [#379](https://github.com/ttoss/soat/issues/379), [#380](https://github.com/ttoss/soat/issues/380) — all fixed by [#381](https://github.com/ttoss/soat/pull/381) |
| 2026-07-05 | same, re-validated post-#381 | all suites pass | [#397](https://github.com/ttoss/soat/issues/397) found while building the Suite 14 REST proxy — fixed and re-validated ([#370](https://github.com/ttoss/soat/issues/370)) |

## Orchestration CRUD

- [x] `POST /orchestrations` (2-node transform graph) → `2xx`, `id` starts `orch_`, fields echo
- [x] `GET /orchestrations/{id}` → `200`, matches the created body
- [x] `GET /orchestrations?project_id=` → `200`, array includes the orchestration
- [x] `PUT /orchestrations/{id}` (rename + node change) → `200`; re-`GET` reflects the change
- [x] `DELETE` a throwaway orchestration → `2xx`; subsequent `GET` → not found
- [x] Unknown `orchestration_id` on `GET`/`PUT`/`DELETE` → clean not-found. MCP error text is readable (was `"[object Object]"` under [#375](https://github.com/ttoss/soat/issues/375))

## Static validation

- [x] `POST /orchestrations/validate` with a valid graph → `{valid: true, errors: [], warnings: []}`
- [x] Missing required field (`agent` node without `agent_id`; `transform` without `expression`) → both flagged, and `create-orchestration` with the same graph is rejected
- [x] Duplicate node id → error
- [x] Dangling edge → error
- [x] Cycle without a `loop` node → error; the same graph **with** a `loop` node → accepted (exemption)
- [x] Unsatisfiable `input_mapping` against a declared `input_schema` → error; without `input_schema` → accepted (open contract)
- [x] Conditional-branch state read (node reachable via two paths, only one of which writes the key) → **warning** only, does not block create

## Sequential execution, state & mappings

- [x] Two-node pipeline: input readable via `{"var": …}`; node A `output_mapping` writes state; node B reads it → run `completed`, `output` populated from the terminal node
- [x] `input_mapping` literal passthrough — verified at the echo tool's received body
- [x] JSON Logic `cat` operator in `input_mapping` resolves against state
- [x] `{"preserve": {"var": "x"}}` passes through as the literal JSON Logic object, unevaluated
- [x] `state_schema` declared → state writes conform; `GET` run reflects all `output_mapping` writes

## Parallel fan-out & fan-in

- [x] One node fanning out to two `tool` nodes → both started at the identical millisecond, overlapping windows in `node_executions`
- [x] Fan-in with `activation_condition: "all"` → merge node ran exactly once, only after both branches completed, both branch outputs in its resolved input
- [x] `activation_condition: "any"` → merge node ran exactly once

## Conditional routing

- [x] `condition` node emits a label; the matching edge traverses → run completes via the selected branch
- [x] The unselected branch's nodes are recorded `status: "skipped"` with null input/output/timestamps
- [x] A label matching no edge → run terminates cleanly (`completed`, all downstream skipped), does not hang

## Node types

- [x] `agent` — prompt resolved from state, `content` written via `output_mapping`; a nonexistent `agent_id` → run `failed`, node execution `failed` with structured `error` (`RESOURCE_NOT_FOUND`)
- [x] `tool` — `input_mapping` resolved and delivered (verified at the echo endpoint); response landed in state
- [x] `transform` — JSON Logic expression over state, result written via `output_mapping`
- [x] `knowledge` — `query` from state returned scored results with `memory_ids` scoping
- [x] `memory_write` — entry persisted, verified via a chained `knowledge` search in the same run
- [x] `delay` — both `"2s"` and ISO `"PT2S"` parsed, each node's duration ≈2000ms
- [x] `sub_orchestration` — child run executed, parent node artifact contained the child's full artifact map

## Loop node

- [x] Loop over a 3-item array → sub-orchestration ran 3×, `{results: [...]}` in item order
- [x] `item_variable` rename → the sub-graph read the renamed variable
- [x] `parallelism: 2` → confirmed by timing: 4 items × 1s each completed in ~2.06s (two sequential batches of 2), not ~1s or ~4s
- [x] Missing / non-array `collection` → zero iterations, `{results: []}`, run does not fail

## Poll node

- [x] Exit condition met on attempt N → artifact `{result, attempts: N, conditionMet: true, timedOut: false}`
- [x] `attempt` and `response` vars usable inside `exit_condition` (confirmed with a combined `and`)
- [x] Exhaustion (`max_iterations` reached, condition never true) → node **completes** with `conditionMet: false, timedOut: true`; a downstream `condition` node branches on it
- [x] `fail_on_timeout: true` + exhaustion → run `failed` with exact code `ORCHESTRATION_POLL_EXHAUSTED`

## Human node & run control

- [x] Run reaches a `human` node → status `paused`, `active_nodes` populated, node execution `requires_action`, and `required_action.type: "human_input"` present (was missing under [#376](https://github.com/ttoss/soat/issues/376))
- [x] `POST /orchestration-runs/{id}/human-input` → run resumes and completes; submitted input visible to downstream nodes. Note the human node's artifact is the raw submitted object, so `output_mapping` must reference its real keys
- [x] `POST /orchestration-runs/{id}/resume` on a paused run re-evaluates from the checkpoint and correctly re-pauses if the human node is still unsatisfied
- [x] `POST /orchestration-runs/{id}/cancel` on a paused run → `cancelled`, `completed_at` set; cancelling the now-terminal run is rejected
- [x] Human input to a non-active node → `ORCHESTRATION_HUMAN_NODE_MISMATCH`

## Webhook node

- [x] `mode: "emit"` → node completes with `{emitted: true}`; a real POST is fired with the `input_mapping`-resolved payload. Fire-and-forget by design (`fetch(...).catch(() => {})`, not awaited), so delivery success is not tracked
- [x] `mode: "receive"` → run pauses (`requires_action`, "Waiting for webhook callback.") with `required_action.type: "webhook_receive"` distinguishing it from a `human_input` pause (was [#377](https://github.com/ttoss/soat/issues/377)). Resume goes through the shared `human-input` endpoint by design

## Runs lifecycle & observability

- [x] `GET /orchestration-runs/{id}` shape matches docs (`state`, `artifacts`, `input`, `output`, timestamps, `trace_id`)
- [x] `GET /orchestration-runs?orchestration_id=` includes all runs for the orchestration
- [x] Failed run → `error` populated at run level **and** on the failing node's execution record; an upstream completed node's output and state write are retained
- [x] A run-time cycle reaching execution is rejected (`"Cycle detected in orchestration graph."`) even when the graph contains an unrelated `loop` node — was [#379](https://github.com/ttoss/soat/issues/379), where the runtime check carried the same blanket loop exemption as the create-time check and therefore added zero protection
- [x] `trace_id` is populated and independently retrievable via `get-trace` when agent nodes ran (was always `null` under [#378](https://github.com/ttoss/soat/issues/378))

## Formation integration (Agent Squads)

- [x] Deploy the Agent Squads template (provider ref + 2 agents + orchestration with `agent_id: {"ref": …}`) → stack `active`, refs resolved to physical `agt_`/`orch_` ids
- [x] `start-orchestration-run` against the stack's `squadId` output → completed; both agents (Writer → Reviewer) ran in sequence with real model output
- [x] Update the template (change a node) → `2xx` for the admin credential (was `403` under [#380](https://github.com/ttoss/soat/issues/380), the same pattern as [#355](https://github.com/ttoss/soat/issues/355))
- [x] Delete the stack → same fix; by-id formation routes no longer `403` for the creator/admin
- [x] Template with an invalid graph (dangling edge) → deploy fails cleanly: stack `failed`, the bad orchestration resource individually `failed`, `list-formation-events` accessible

## MCP tool-surface parity

- [x] `tools/list` includes the orchestration operations — implicitly proven: the entire pass was driven through this surface (create/validate/get/list/update/delete/start-run/get-run/list-runs/cancel/human-input/resume)
- [x] `tools/call create-orchestration` + `start-orchestration-run` round-trip with camelCase fields (`inputMapping`, `outputMapping`, `agentId`) maps correctly to/from the snake_case REST contract
- [x] Validation failures via MCP surface the same structured errors, for mutating calls as well as reads (was `"[object Object]"` under [#375](https://github.com/ttoss/soat/issues/375))

## AuthN / AuthZ

- [x] Every endpoint without a token → `401`. Confirmed live via a scratch `http`-type tool proxying an unauthenticated `GET /orchestrations`, plus source (`resolveAuth` / `resolveRunAuth`) and a passing per-route unit test
- [x] User without `orchestrations:*` actions → `403` on each of the 12 actions (source + the per-route `403` unit tests + a real `sk_` key tested against `StartRun`)
- [x] Cross-project isolation — orchestrations' auth is built on the shared `resolveProjectIds`/`isAllowed` primitives that `permissionsFlow.test.ts` (Groups 6, 10, 11) already proves reject cross-project access for both API keys and JWT-policy scoping
- [x] API-key (`sk_`) auth for start-run / get-run — the entire pass authenticated via a project-scoped API key, so every check above is live positive-path evidence

Live identity-swapping through the MCP interface (to drive these as raw REST calls
with different credentials per call) is not possible: the platform has no
mechanism for injecting a caller-supplied bearer token into a stored tool's
headers at call time (only `{{secret:…}}`-backed static headers). That is by
design, not a gap.

## Out of scope at the time of the pass

These were deliberately not tested because they were unimplemented. Re-check
whether they have since shipped before the next pass.

- [ ] Background / durable run execution ([#366](https://github.com/ttoss/soat/issues/366)) — runs executed in the request loop by design
- [ ] Scheduled or webhook-initiated triggers ([#367](https://github.com/ttoss/soat/issues/367))
- [ ] Waits beyond the documented `poll` bounds — *unsupported by design (10-minute wall-clock ceiling, `max_iterations` ≤ 1000); nothing to verify unless the bounds change*

## Bonus finding

[#397](https://github.com/ttoss/soat/issues/397) — `POST /tools/{tool_id}/call`
(and the MCP `call-tool` surface) collapsed every non-2xx response from an
`http`-type tool's target into a bare `500`, discarding the real upstream
status/body: a `401` from the target was indistinguishable from a SOAT-side crash.
Root cause was `HttpToolError` not being recognized by
`errorLogger.ts#getErrorStatus`, unlike `DomainError`. Fixed with a
`TOOL_HTTP_ERROR` (502) carrying `tool_status_code` / `tool_response_body` /
`tool_url` / `tool_method` in `meta`.
