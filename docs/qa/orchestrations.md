# QA checklist — orchestrations

Module docs: [`packages/website/docs/modules/orchestrations.md`](../../packages/website/docs/modules/orchestrations.md)
Also covers the `orchestration` formation resource type (Agent Squads).
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-03 | `soat-tests` MCP project-key credential (admin, project `proj_ElQRuVqixOmM9Qva`, full-access policy), AI provider `bedrock` / `deepseek.v3.2` | 6 defects found | [#375](https://github.com/ttoss/soat/issues/375), [#376](https://github.com/ttoss/soat/issues/376), [#377](https://github.com/ttoss/soat/issues/377), [#378](https://github.com/ttoss/soat/issues/378), [#379](https://github.com/ttoss/soat/issues/379), [#380](https://github.com/ttoss/soat/issues/380) — all fixed by [#381](https://github.com/ttoss/soat/pull/381) |
| 2026-07-05 | same, re-validated post-#381 | all suites pass | [#397](https://github.com/ttoss/soat/issues/397) found while building the Suite 14 REST proxy — fixed and re-validated ([#370](https://github.com/ttoss/soat/issues/370)) |
| 2026-07-26 | `soat.naturali.ai` via REST + CLI + `soat-tests` MCP (project `proj_ck7jvYsjVKI9UHCG`), AI provider `bedrock` / `deepseek.v3.2`, Postgres queue driver, in-API worker. ~35 graphs, ~40 runs | Re-baselined the whole checklist against the post-durable-execution contract (`queued`/`sleeping`/`awaiting_input`, `state_mapping`, `emit_event`). 3 doc defects + 1 code defect | [#721](https://github.com/ttoss/soat/issues/721), [#722](https://github.com/ttoss/soat/issues/722), [#723](https://github.com/ttoss/soat/issues/723), [#724](https://github.com/ttoss/soat/issues/724) — all fixed by [#727](https://github.com/ttoss/soat/pull/727) |

> **Vocabulary note.** The 2026-07-03/05 rows were run before durable execution
> ([#366](https://github.com/ttoss/soat/issues/366) / [#407](https://github.com/ttoss/soat/issues/407)) and the
> [#410](https://github.com/ttoss/soat/issues/410) rename. Items below describe the **current**
> contract (`state_mapping`, not `output_mapping`; `awaiting_input`, not `paused`),
> re-verified on 2026-07-26 unless the annotation says otherwise.
>
> The item count grew from 66 to 133 in that pass because the module roughly
> doubled its documented surface (durable queue-backed execution, retry policy,
> `approval` nodes, guardrail interception, `emit_event`, the `nodes.<id>`
> namespace, run usage, queue stats). The coverage **ratio** therefore dips
> from 63/66 to 119/133 without anything regressing — the denominator moved.

## Orchestration CRUD

- [x] `POST /orchestrations` (2-node transform graph) → `2xx`, `id` starts `orch_`, fields echo
- [x] `GET /orchestrations/{id}` → `200`, matches the created body
- [x] `GET /orchestrations?project_id=` → `200`, array includes the orchestration
- [x] `PATCH /orchestrations/{id}` (rename + node change) → `200`; re-`GET` reflects the change
- [x] `DELETE` an orchestration → `204`; subsequent `GET` → `404`, **and its runs are also gone** (`GET` a run of the deleted orchestration → `404`)
- [x] Unknown `orchestration_id` on `GET`/`PATCH`/`DELETE` → clean not-found. MCP error text is readable (was `"[object Object]"` under [#375](https://github.com/ttoss/soat/issues/375))

## Static validation

- [x] `POST /orchestrations/validate` with a valid graph → `{valid: true, errors: [], warnings: []}` — the exact snippet in the module docs' Static Validation section returns this verbatim
- [x] Missing required field (`agent` without `agent_id`; `transform`/`condition` without `expression`) → each flagged with its own `path`
- [x] Duplicate node id → error
- [x] Dangling edge → error on both `from` and `to`
- [x] Cycle without a `loop` node → error; the same graph **with** a `loop` node → accepted (exemption)
- [x] Unsatisfiable `input_mapping` against a declared `input_schema` → error whose message states run input is only readable as `{"var": "input.x"}`; without `input_schema` → accepted (open contract)
- [x] Unsatisfiable `nodes.<id>` reference (`nodes.ghost.…`) → error **regardless** of `input_schema`
- [x] `state_mapping` key targeting the reserved `nodes` namespace (`state.nodes.x`) → error
- [x] Conditional-branch state read → **warning** only, `valid: true`, does not block create
- [x] `create-orchestration` / `update-orchestration` reject an invalid graph with `400` `ORCHESTRATION_VALIDATION_FAILED`, carrying the full `errors`/`warnings` arrays in `error.meta`

## Sequential execution, state & mappings

- [x] Two-node pipeline: node A `state_mapping` writes state; node B reads it → run `succeeded`, `output` populated from the terminal node's artifact
- [x] `input_mapping` literal passthrough — verified at the echo tool's received body
- [x] JSON Logic `cat` operator in `input_mapping` resolves against state
- [x] `{"preserve": {"var": "x"}}` passes through as the literal JSON Logic object, unevaluated
- [x] `state_mapping` key **without** the `state.` prefix is normalized to state-relative
- [x] A **dotted** `state_mapping` target (`state.proposed.action_id`) builds a nested object, read back by a later node via `{"var": "proposed.action_id"}`
- [x] `state_mapping` computing a derived value (`{"+": [{"var": "output.result"}, 100]}`) writes the computed result, not the raw artifact
- [x] `state_schema` declared → state writes conform; `GET` run reflects all `state_mapping` writes

### Run input namespace

- [x] Run `input` seeds `state.input`, read as `{"var": "input.<key>"}`
- [x] Input keys round-trip **verbatim** over REST — a key sent as `cycle_task` stays `cycle_task` (not case-transformed). *Note: the MCP surface does camelCase it on the way back out — a known, intentional limitation documented at `toMcpText.ts`'s `VERBATIM_KEYS`, since MCP has no request path to scope free-form bags by*
- [x] A **flat** `{"var": "<key>"}` reference is **not** satisfied by run input (resolves `null`); only `{"var": "input.<key>"}` reads it — the old flat alias is genuinely removed
- [x] `{"var": "input.<undeclared>"}` satisfies static validation regardless of `input_schema`
- [x] An `input_schema` property named `nodes` is accepted (no collision with the reserved state namespace)

### The `nodes.<id>` namespace

- [x] Every completed node's artifact appears at `state.nodes.<nodeId>` with no explicit wiring on the upstream node
- [x] A downstream node reads it via `{"var": "nodes.<id>.<field>"}`
- [x] A `condition` node's namespace entry is `{label}`, read as `{"var": "nodes.<id>.label"}`

### Node artifact shapes

Each shape below was read off a real run's `artifacts` / `state.nodes.<id>` and is
the basis of the module docs' **Node artifacts** table (added by [#721](https://github.com/ttoss/soat/issues/721)).

- [x] `tool` → the tool's **result object verbatim** (a `{"status":"ok"}` response yields `{"status":"ok"}`); only a non-object result is wrapped as `{result}`. This is what made the docs' `{"var": "output.result"}` example silently write `null` — was [#721](https://github.com/ttoss/soat/issues/721)
- [x] `agent` → `{content}`
- [x] `transform` → `{result}`
- [x] `knowledge` → `{results}`
- [x] `memory_write` → `{action}`
- [x] `delay` → `{waited}`
- [x] `emit_event` → `{emitted, eventType}`
- [x] `poll` → `{result, attempts, conditionMet, timedOut}`
- [x] `loop` → `{results}`
- [x] `sub_orchestration` → the child run's `output` (`{terminalNodeId: terminalArtifact}`), **not** a flattened value
- [x] `approval` → `{decision, approvalId, resolvedBy, reason, result, editedArgs}`
- [x] `human` / `webhook(receive)` → the submitted payload verbatim
- [ ] `agent` with an `output_schema` → the parsed JSON object replaces `{content}` — *not exercised this pass; verified only by reading `parseAgentOutput`*

## Parallel fan-out & fan-in

- [x] One node fanning out to two `tool` nodes → both started at the identical millisecond, overlapping windows in `node_executions`
- [x] Fan-in with `activation_condition: "all"` → merge node ran exactly once, only after both branches completed, both branch outputs readable in its expression
- [x] `activation_condition: "any"` → merge node ran exactly once

## Conditional routing

- [x] `condition` node emits a label; the matching edge traverses → run completes via the selected branch
- [x] The unselected branch's nodes are recorded `status: "skipped"` with null `input`/`output`/`started_at`/`completed_at`
- [x] A label matching no edge → run terminates cleanly, does not hang

## Node types

- [x] `agent` — prompt resolved from state, `content` written via `state_mapping`; a nonexistent `agent_id` → run `failed`, node execution `failed` with structured `error`. The code is `RESOURCE_NOT_FOUND` (propagated from `getAgent`), **not** `ORCHESTRATION_NODE_FAILED` as the docs claimed — was [#723](https://github.com/ttoss/soat/issues/723)
- [x] `tool` — `input_mapping` resolved and delivered; response landed in state
- [x] `transform` — JSON Logic expression over state, result written via `state_mapping`
- [x] `knowledge` — `query` from state returned scored results with `memory_ids` scoping
- [x] `memory_write` — entry persisted, verified via a chained `knowledge` search in the same run
- [x] `delay` — parses both `"8s"` and ISO `"PT2S"`; parks the run as `sleeping` and resumes on schedule (see Durable execution)
- [x] `sub_orchestration` — child run executed; the parent node's artifact is the child's `output`, and `{"var": "output.<terminalNode>.<field>"}` descends into it directly with no intermediate `transform`
- [x] `emit_event` — emits an internal event; artifact `{emitted: true, eventType}`; the run neither blocks on nor fails from delivery. Replaces the old `webhook mode: "emit"`

## Loop node

- [x] Loop over a 3-item array → sub-orchestration ran 3×, `{results: [...]}` in item order, each entry the sub-run's `output`
- [x] `item_variable` rename → the sub-graph read it as `{"var": "input.<name>"}` (item is passed as the sub-run's **input**)
- [x] Missing / non-array `collection` → zero iterations, `{results: []}`, run does not fail
- [x] `collection` without the `state.` prefix is normalized
- [x] `parallelism: 2` → confirmed by timing on the 2026-07-05 pass: 4 items × 1s each completed in ~2.06s (two sequential batches of 2) — *not re-timed on 2026-07-26*

## Poll node

- [x] Exit condition met on attempt 1 → artifact `{result, attempts: 1, conditionMet: true, timedOut: false}`
- [x] `attempt` and `response` vars usable inside `exit_condition`
- [x] Exhaustion (`max_iterations` reached, condition never true) → node **completes** with `conditionMet: false, timedOut: true`; a downstream `condition` node branches on it via `{"var": "nodes.<id>.conditionMet"}`
- [x] `fail_on_timeout: true` + exhaustion → run `failed` with exact code `ORCHESTRATION_POLL_EXHAUSTED`

## Approval node

- [x] Run reaches an `approval` node → `awaiting_input` with `required_action.type: "approval"`, carrying `approval_id` and `expires_at`
- [x] `arguments` and `reasoning` are resolved against run state and **frozen** onto the created ApprovalItem (under `proposed_action.tool_id` / `proposed_action.arguments`), which also carries `run_id` + `node_id` and `origin: "node"`
- [x] Omitted `expires_in` defaults to 24h
- [x] Approve → decision becomes the branch label; the **unlabeled** edge follows and the `rejected` branch is `skipped`
- [x] Reject → the `condition: "rejected"` edge follows, the unlabeled success edge does **not**, artifact carries `{decision: "rejected", reason}`
- [ ] Server-side expiry routes down an `expired` edge — *not exercised; needs a short `expires_in` plus the expiry sweeper, which is time-based*

## Guardrail interception on tool nodes

- [x] Class **A** (no guardrail) → tool runs with the cleaned `input_mapping` result
- [x] Class **C** → run parks with `required_action.type: "approval"` and files an ApprovalItem with the frozen args; on approval the tool is **re-dispatched for real** (artifact is the live tool result) and the success edge continues
- [x] Class **D** → routable `blocked` outcome: artifact `{status: "blocked", reason}`, a `condition: "blocked"` edge routes to the fallback, and the **unlabeled success edge does not follow** (happy path recorded `skipped`)
- [ ] Stricter-wins composition across project + tool scopes — *not exercised; see the [guardrails checklist](./guardrails.md), which owns scope composition*

## Human node & run control

- [x] Run reaches a `human` node → status `awaiting_input`, `active_nodes` populated, node execution `requires_action`, `required_action.type: "human_input"` with `node_id` + `prompt` (was missing under [#376](https://github.com/ttoss/soat/issues/376))
- [x] `POST /orchestration-runs/{id}/human-input` → run resumes and completes; the submitted payload is the node's artifact and is readable downstream via `nodes.<id>`
- [x] The paused node's own `requires_action` record is updated **in place** to `completed` with `output` = the submitted payload and `completed_at` set — never left behind as `requires_action`
- [x] `POST /orchestration-runs/{id}/resume` re-drives an `awaiting_input` run and re-parks when the pause is still unsatisfied — **and no longer appends a duplicate `requires_action` record per call** (was [#724](https://github.com/ttoss/soat/issues/724): 3 resumes produced 3 identical records at the same `attempt`, all later flipped to `completed`)
- [x] `resume` cannot *satisfy* a pause — it takes no `node_id`/payload, so only `submit-human-input` advances a `human` node (the docs claimed otherwise — [#724](https://github.com/ttoss/soat/issues/724))
- [x] `POST /orchestration-runs/{id}/cancel` on a parked run → `cancelled`, `completed_at` set; cancelling the now-terminal run is rejected
- [x] Human input to a non-active node → `ORCHESTRATION_HUMAN_NODE_MISMATCH`
- [x] `resume` on a terminal run → `409` `ORCHESTRATION_RUN_NOT_AWAITING_INPUT`

## Webhook node

- [x] `mode: "receive"` → run parks with `required_action.type: "webhook_receive"`, distinguishing it from a `human_input` pause (was [#377](https://github.com/ttoss/soat/issues/377)). Resume goes through the shared `human-input` endpoint by design — there is no separately-authenticated callback endpoint
- [x] The delivered payload becomes the node's artifact and is readable downstream

## Durable background execution

- [x] Async `start-orchestration-run` returns immediately with `status: "queued"` and an empty `node_executions` — no node executes inside the request. The docs and OpenAPI said `"running"` — was [#722](https://github.com/ttoss/soat/issues/722)
- [x] The queued run advances on its own and reaches `succeeded` without further calls
- [x] `wait: true` blocks until the run settles (terminal or `awaiting_input`) and returns the settled run
- [x] A `delay` node parks the run as `sleeping` with `active_nodes` naming the node, holds no worker, then wakes and completes
- [x] `wake_at` is **not** exposed on the run — `active_nodes` is a flat array of node-id strings. The troubleshooting docs pointed at `active_nodes[].wake_at` — was [#723](https://github.com/ttoss/soat/issues/723)
- [x] Run lifecycle webhook events fire for all four documented types: `orchestration_runs.started`, `.awaiting_input`, `.succeeded`, `.failed` (verified via a real subscribed webhook's delivery records)
- [x] `GET /orchestrations/queue/stats` → documented shape (`driver: "postgres"`, `queue_depth`, `claimed_tasks`, `oldest_queued_age_seconds`, rolling `claim_latency_ms` percentiles with `window_seconds: 300`, `per_project`)
- [ ] Per-project `max_concurrent_runs` enforced at claim time — *not exercised; needs contended, actively-driven runs to observe a task staying `queued`*
- [ ] Reaper reclaims an expired-lease `running` run and re-drives from checkpoint — *not exercised; needs a killed worker mid-run*
- [ ] `Idempotency-Key` forwarded by an `http` tool node — *not exercised; needs a request-echoing target that surfaces headers*
- [ ] Redelivery of a completed keyed node reuses the stored output without re-invoking — *internal seam; covered by unit tests, not observable through a surface*
- [ ] `sqs` queue driver, standalone `worker.js`, and the heartbeat healthcheck — *needs a different deployment topology than the single-process instance under test*

## Retry policy

- [x] A node with `retry.max_attempts: 3` against a transient failure (unreachable host) → run parks `sleeping` between attempts
- [x] Each attempt writes its **own** `node_executions` record with an incrementing `attempt` (1, 2, 3)
- [x] Exhausting the attempt budget fails the run
- [ ] A terminal `4xx` fails immediately **without** consuming attempts — *not exercised; needs a target returning a deliberate 4xx*
- [ ] `backoff.strategy: "exponential"` doubling and `max_delay_ms` capping — *not measured; only `fixed` was timed*

## Runs lifecycle & observability

- [x] `GET /orchestration-runs/{id}` shape matches docs (`state`, `artifacts`, `input`, `output`, `active_nodes`, `required_action`, `error`, timestamps, `trace_id`, `usage`)
- [x] `GET /orchestration-runs?orchestration_id=` includes all runs for the orchestration
- [x] `node_executions` returned by **both** the single-run read and the list, oldest-first
- [x] `usage` is present on the single-run read and **omitted** from list responses
- [x] Failed run → `error` populated at run level **and** on the failing node's record, with the resolved `input` it received; an upstream completed node's output and state write are retained
- [x] A run-time cycle reaching execution is rejected (`ORCHESTRATION_CYCLE_DETECTED`) even when the graph contains an unrelated `loop` node — was [#379](https://github.com/ttoss/soat/issues/379). *Verified 2026-07-05; not re-reachable on 2026-07-26 since create-time validation now blocks the graph*
- [x] `trace_id` is populated and independently retrievable via `get-trace` when agent nodes ran (was always `null` under [#378](https://github.com/ttoss/soat/issues/378))

## Run usage

- [x] An `agent` node's generation meters against the run: `usage` rolls up `total_input_tokens`, `total_output_tokens`, `total_cached_tokens`, `total_reasoning_tokens`, `total_cost_usd`
- [x] `GET /usage/receipt?run_id=` returns the per-event breakdown (`line_items`, `by_meter_type`), including the `compute_execution` meter alongside `llm_tokens`
- [x] The roll-up is populated on `get-orchestration-run`, **not** necessarily on the `wait: true` start response — usage events land as generations settle, so the start response can carry `usage: null` (documented as a caveat by [#727](https://github.com/ttoss/soat/pull/727))
- [ ] `total_cost_usd` populated from a price book — *unpriced on this instance (`cost_usd: null` throughout); pricing is verified in the [quotas](./quotas.md) / usage passes*
- [ ] `trigger_id` propagated onto in-run generation usage events — *not exercised; the trigger pass below used a transform-only graph with no generation*

## Triggers

- [x] A `manual` trigger with `target_type: "orchestration"` → fires a run that reaches `succeeded`; the firing record carries the run id under `result`
- [ ] `cron` / inbound-webhook trigger types driving an orchestration — *owned by the triggers module; not yet on its own checklist (see the pending list)*

## Formation integration (Agent Squads)

All verified on the 2026-07-05 pass; not re-run on 2026-07-26.

- [x] Deploy the Agent Squads template (provider ref + 2 agents + orchestration with `agent_id: {"ref": …}`) → stack `active`, refs resolved to physical `agent_`/`orch_` ids
- [x] `start-orchestration-run` against the stack's `squad_id` output → completed; both agents (Writer → Reviewer) ran in sequence with real model output
- [x] Update the template (change a node) → `2xx` for the admin credential (was `403` under [#380](https://github.com/ttoss/soat/issues/380), same pattern as [#355](https://github.com/ttoss/soat/issues/355))
- [x] Delete the stack → same fix; by-id formation routes no longer `403` for the creator/admin
- [x] Template with an invalid graph (dangling edge) → deploy fails cleanly: stack `failed`, the bad orchestration resource individually `failed`, `list-formation-events` accessible

## MCP tool-surface parity

- [x] `tools/list` includes the orchestration operations — the 2026-07-03/05 passes were driven entirely through this surface
- [x] `tools/call create-orchestration` + `start-orchestration-run` round-trip with camelCase fields maps correctly to/from the snake_case REST contract
- [x] Validation failures via MCP surface the same structured errors, for mutating calls as well as reads (was `"[object Object]"` under [#375](https://github.com/ttoss/soat/issues/375))
- [x] Free-form bags (`input`, `state`, `input_schema` properties) are camelCased on the MCP read path while REST keeps them verbatim — intentional and documented in `toMcpText.ts`; the stored graph is unaffected (confirmed by reading an MCP-created orchestration back over REST)

## AuthN / AuthZ

- [x] Every endpoint without a token → `401`. Confirmed live via a scratch `http`-type tool proxying an unauthenticated `GET /orchestrations`, plus source (`resolveAuth` / `resolveRunAuth`) and a passing per-route unit test
- [x] User without `orchestrations:*` actions → `403` on each action (source + per-route `403` unit tests + a real `sk_` key tested against `StartRun`)
- [x] Cross-project isolation — built on the shared `resolveProjectIds`/`isAllowed` primitives that `permissionsFlow.test.ts` (Groups 6, 10, 11) proves reject cross-project access for both API keys and JWT-policy scoping
- [x] API-key (`sk_`) auth for start-run / get-run — the 2026-07-03/05 passes authenticated entirely via a project-scoped API key
- [ ] `orchestrations:GetQueueStats` denied for a caller without the action, and `per_project` scoped to a project-scoped caller's own projects — *the 2026-07-26 pass called it with an admin credential only*

Live identity-swapping through the MCP interface (to drive these as raw REST calls
with different credentials per call) is not possible: the platform has no
mechanism for injecting a caller-supplied bearer token into a stored tool's
headers at call time (only `{{secret:…}}`-backed static headers). That is by
design, not a gap.

## Not covered

Every unchecked box above, grouped by why:

- **Needs a different deployment topology** — `sqs` driver, standalone worker
  process, heartbeat healthcheck, reaper crash-recovery, per-project
  `max_concurrent_runs` contention.
- **Needs a purpose-built target** — `Idempotency-Key` header forwarding, a
  deliberate `4xx` for terminal-error retry semantics, exponential backoff timing.
- **Time-based** — approval expiry routing down an `expired` edge.
- **Internal seam, not observable through a surface** — keyed-node redelivery
  reuse (unit-tested instead).
- **Owned by another module's checklist** — guardrail scope composition
  ([guardrails](./guardrails.md)), price-book cost attribution
  ([quotas](./quotas.md)), cron/webhook trigger types (triggers, pending).
- **Not re-run on 2026-07-26** — loop `parallelism` timing and the Agent Squad
  formation suite (both verified 2026-07-05 and still ticked on that basis).

## Bonus finding

[#397](https://github.com/ttoss/soat/issues/397) — `POST /tools/{tool_id}/call`
(and the MCP `call-tool` surface) collapsed every non-2xx response from an
`http`-type tool's target into a bare `500`, discarding the real upstream
status/body: a `401` from the target was indistinguishable from a SOAT-side crash.
Root cause was `HttpToolError` not being recognized by
`errorLogger.ts#getErrorStatus`, unlike `DomainError`. Fixed with a
`TOOL_HTTP_ERROR` (502) carrying `tool_status_code` / `tool_response_body` /
`tool_url` / `tool_method` in `meta`.
