# QA checklist — workflows

Covers the **workflow definition** resource, per-state automation, and the
cross-cutting surfaces (permissions, MCP/CLI/SDK, webhooks, formation resource).
The **task** instance resource has its own checklist: [`tasks.md`](./tasks.md).

Module docs: [`packages/website/docs/modules/workflows.md`](../../packages/website/docs/modules/workflows.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Pass | Surface | Result | Defects filed |
|---|---|---|---|---|
| 2026-07-18 | 1/4 — definition CRUD & validation ([#594](https://github.com/ttoss/soat/issues/594)) | live `soat.naturali.ai`, CLI, dedicated project + second project for cross-project checks | 18/19 | delete-after-close deviation |
| 2026-07-18 | 3/4 — per-state automation ([#596](https://github.com/ttoss/soat/issues/596)) | live server, CLI + raw REST `v0.15.9`, 9 purpose-built workflows, 2 orchestrations | all items exercised | 2 deviations |
| 2026-07-18 | 4/4 — permissions, MCP/CLI/SDK, webhooks, docs ([#597](https://github.com/ttoss/soat/issues/597)) | live server, CLI + REST + raw MCP JSON-RPC, 4 principals + `sk_` key + webhooks | all items exercised | [#608](https://github.com/ttoss/soat/issues/608), [#609](https://github.com/ttoss/soat/issues/609) + 2 more |
| 2026-07-19 | 5 — Phase 3: approvals, human states, stall sweeper ([#616](https://github.com/ttoss/soat/issues/616)) | deployed `soat-tests`, MCP surface | all pass, no deviations | none |
| 2026-07-19 | 6 — Phase 4: formation resource & board view ([#617](https://github.com/ttoss/soat/issues/617)) | deployed `soat-tests` (MCP) + app unit suite on `main` | all pass, no deviations | none |

## Create & validation

- [x] Valid definition (≥2 states, exactly one `initial: true`, transitions referencing existing states) → `201`, `id` has `wfl_` prefix, snake_case body fields
- [x] Zero states → `400 WORKFLOW_VALIDATION_FAILED`
- [x] Two states marked `initial: true` → `400` (message mentions count)
- [x] No `initial` state at all → `400`
- [x] Duplicate state names → `400`; duplicate transition names → `400`
- [x] Transition with unknown `from` state → `400`; unknown `to` state → `400`; empty `from` array → `400`
- [x] Guard that is not an object (e.g. `"guard": "yes"`) → `400`
- [x] `kind: human` state **with** `on_enter` → `400` (human states never dispatch)
- [x] `on_enter.dispatch.kind: agent` without `agent_id` → `400`; `kind: orchestration` without `orchestration_id` → `400`; unknown dispatch kind → `400`
- [x] `on_enter` referencing a nonexistent agent id → `400` with the id in the message; same for a nonexistent orchestration id; same for an agent in **another project**
- [x] `on_complete` rule referencing an unknown transition name → `400`; `on_failure` likewise → `400`
- [x] `stalled_after` accepts a positive integer; `-5` → `400` ("must be a positive number of seconds")
- [x] `requires_approval: true` is **accepted** as of Phase 3 (the interim [#591](https://github.com/ttoss/soat/issues/591) rejection was lifted)

## Read / list / update / delete

- [x] `get-workflow` returns the full definition; `list-workflows` includes it; no internal numeric DB ids in either response
- [x] Cross-project isolation holds — a project-scoped key gets `403` on another project's workflow and an empty list. Note: this is a hard project match in `middleware/auth.ts`, independent of IAM policy, so it is `403` rather than the `404`-or-filtered wording the original checklist used
- [x] `update-workflow` with a structurally invalid definition → `400`, stored definition **unchanged** on re-fetch
- [x] Update that removes a state an open task occupies → update succeeds; the parked task keeps its state and the now-gone transition correctly returns `400 TASK_TRANSITION_NOT_FOUND`
- [x] `delete-workflow` while an **open** task exists → `409 WORKFLOW_HAS_OPEN_TASKS`
- [ ] `delete-workflow` after closing the task → deviation observed in the 2026-07-18 pass; see [#594](https://github.com/ttoss/soat/issues/594) results comment

## Payload schema

- [x] `payload_schema` with `required: ["topic"]` — create-task without `topic` → `400 TASK_PAYLOAD_INVALID`; wrong type → `400`; valid payload → `201`

## Per-state automation — agent dispatch

- [x] Creating a task fires the initial state's dispatch automatically; `active_dispatch.kind: generation`, `automation_status` follows `running → completed`
- [x] `input_mapping` JSON Logic over `{"var": "task.payload…"}` resolves — verified in the generation content
- [x] The generation's result lands in `task.payload.last_result`
- [x] The dispatched generation is metered and traced exactly like a directly-created one (visible via `get-generation` / `list-generations`)

## Per-state automation — orchestration dispatch

- [x] Entering the state starts a run (visible in `list-orchestration-runs`); `active_dispatch.kind: orchestration_run`
- [x] `{result}` exposed to `on_complete` is the run's final **state** object (`{input, nodes, result}`), not `node_executions` or a flattened `output`

## `on_complete` routing

- [x] First-match-wins across two rules; history records `actor_kind: automation` and the causing `generation_id`/`run_id`
- [x] No rule matches → task **stays**, `automation_status: completed`, `tasks.automation_unrouted` fires with the result in `extra`
- [x] Guard-rejected routing → `automation_status: unrouted` (distinguishable from the plain completed-and-parked case) and `tasks.automation_rejected` fires carrying `transition` + `error_code: TASK_GUARD_REJECTED`

## `on_failure`

- [x] Terminal dispatch failure with `on_failure` set → task auto-transitions via the named transition, `actor_kind: automation` in history
- [x] Same failure with `on_failure` omitted → task stays, `automation_status: failed`, `active_dispatch.status: failed`

## Cancellation on exit / re-entrancy

- [x] Manual transition out of a state with a `running` orchestration dispatch → transition succeeds immediately, the run is cancelled, `active_dispatch` reflects the **new** state
- [x] Manual transition out while an **agent** generation is running → the late result is discarded: `payload.last_result` not written by the stale generation, no stale `on_complete` transition, `active_dispatch`/`automation_status` not overwritten
- [x] Re-entering the same state starts a **fresh** dispatch; at most one active dispatch per task at all times
- [x] `kind: human` state never dispatches; task parks until a principal transitions it

## Chained automation

- [x] Full auto-advance chain (A routes to B, B routes to C) completes end-to-end with a correct, ordered history

## Approval-gated transitions

- [x] Firing a gated transition does **not** move the task: state unchanged, `pending_transition` set, pending `ApprovalItem` created (`origin: task_transition`, task linkage, 24h expiry)
- [x] Firing a second transition while one is pending → rejected, "has transition … pending approval"
- [x] **Approve** → transition fires as the `approval` actor; history shows `actor_kind: approval` with note `Approved via approval apr_…`; task closed on entering a terminal state; `pending_transition` cleared
- [x] **Approve with a now-failing guard** → task does not move, `pending_transition` cleared, `tasks.approval_failed` delivered with `transition` and `errorCode: TASK_GUARD_REJECTED`
- [x] **Reject** → `pending_transition` cleared, history note `Approval rejected: … Transition not applied.` (`actor_kind: approval`, `transition: null`), task never moved

## Stall / SLA sweeper

- [x] A task parked past `stalled_after` gets exactly **one** `tasks.stalled` webhook per episode (verified across 4 tasks and multiple sweeper ticks, no duplicates)
- [x] The stall is an event, not a transition — task state unchanged
- [x] The deadline re-arms on the next transition (task cycled `review → triage → review` received a second `tasks.stalled` for episode 2)
- [x] Entering a state without `stalled_after` sets no deadline

## Permissions

- [x] Unauthenticated → `401` on all 12 routes (5 workflow + 7 task)
- [x] No-permission user → `403` on all 12 routes
- [x] Per-action gating: a read-only policy gets `200` on get/list/history, `403` on transition/create/update/delete
- [x] `sk_` API key completes the full lifecycle; history records `actor_kind: api_key`
- [x] Cross-project isolation holds (`403` cross-project, no leak in list queries)

## MCP / CLI / SDK surfaces

- [x] All 12 MCP tools exist and are callable (verified via `tools/list` and direct calls)
- [x] MCP inputs/outputs are **camelCase** (`workflowId`, `enteredStateAt`, `automationStatus`) while REST is snake_case
- [x] A guard-rejected `transition-task` via MCP surfaces as `isError: true` with a readable message. `DomainError` `code`/`meta` are intentionally dropped by `mcp/callApi.ts` — a design choice, not a defect
- [x] A no-permission JWT on MCP gets `{isError: true, text: "Forbidden"}`, not a crash
- [x] SDK: `body`/response fields snake_case, path params snake_case

## Webhook events

- [x] `tasks.created` on create; `tasks.transitioned` on every move (with `transition` and `fromState`); `tasks.closed` on entering a terminal state; `tasks.automation_unrouted` when no `on_complete` rule matches
- [x] A webhook subscribed to `tasks.*` receives all of the above; one subscribed to only `tasks.closed` receives only that
- [x] Event payload carries the mapped task — public ids only, no internal numeric ids

## Formation resource

- [x] A workflow-resource template passes `validate-formation`; an unknown field is rejected with the allowed-field list (`name, description, states, transitions, payload_schema`)
- [x] `create-formation` deploys the workflow (`status: created`, physical `wfl_…`); `get-workflow` matches the template
- [x] `update-formation` adding a state + two transitions re-validates and applies
- [x] `plan-formation` diff is accurate (unchanged name → update action, full states/transitions diff shown)
- [x] Formation delete with an **open** task fails (`status: delete_failed`, resource retained); succeeds once the task is terminal
- [x] The validator's allowlist matches the REST `workflows.yaml` create/update surface — no drift

## Generic board view (`@soat/app`)

- [x] Board renders one column per workflow state with tasks as cards, querying with the `workflow_id` filter
- [x] Tasks in states missing from the definition render as extra columns — nothing dropped; terminal flags extracted
- [x] Clicking a card navigates to the task detail view; workflow-fetch failure surfaces an error; empty-state and no-collection cases show hints
- [x] App unit tests green (`boardView.test.tsx`, `boardUtils.test.ts`), MSW-only mocking per the app-tests rules

The board is **read-only by design** — transitions fire from the task detail
view. Board-level drag/transition would be a new feature, not a Phase 4 gap.

## Docs & vocabulary

- [x] `workflows.md` matches shipped behavior: data-model tables list every returned field, error table matches real codes/status
- [x] Both `workflows.md` and `orchestrations.md` open with the cross-linked "which one do I use?" table
- [x] No occurrence of "orchestration workflow" or "workflow pipeline" in docs, CLI help, or error messages (denylist in `scripts/docs-lint.mjs`)
- [x] The linked tutorial runs end-to-end via the tutorials harness

## Kanban success criterion

- [x] The full board scenario builds with zero application-side state: workflow = board, tasks = cards, `list-tasks --workflow-id --state` = columns, history = card activity, including one backward move — all via CLI only

## Not covered

- [ ] **Approval expiry** — follows the approvals module's server-side sweeper on a 24h window, so it was not live-tested. Covered by the approvals expiry sweeper unit tests and `tasksApprovalGate` tests on `main`.
