# QA checklist — tasks

Covers the **task** instance resource and `transitionTask` semantics. The
workflow *definition* resource, per-state automation, and the cross-cutting
surfaces are in [`workflows.md`](./workflows.md).

Module docs: [`packages/website/docs/modules/workflows.md`](../../packages/website/docs/modules/workflows.md)
(tasks are documented on the workflows page)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-18 | live server, `soat` CLI + raw REST `v0.15.9`, fresh `content-pipeline` workflow (`triage → draft ⇄ review → published`, guarded `publish`, no `on_enter`) | all 20 items exercised, all pass as specified | [#605](https://github.com/ttoss/soat/issues/605) — `TASK_STATE_NOT_WRITABLE` never thrown ([#595](https://github.com/ttoss/soat/issues/595)) |

## Creation & placement

- [x] `create-task --workflow-id --title --payload` → `201`, `id` prefixed `task_`, `state` = the initial state, `status: open`, `entered_state_at` set
- [x] `get-task-history` shows exactly one `tasks.created` record — `from_state: null`, `to_state: <initial>`, `transition: null`, `actor_kind` matching the caller
- [x] Unknown `workflow_id` → `404 WORKFLOW_NOT_FOUND`; a workflow from another project → same rejection

## Transitions — the single path

- [x] Valid forward move → `200`, `state` updated, `entered_state_at` refreshed
- [x] **Backward move** (`review → draft` then back) succeeds — the core differentiator vs orchestrations; both moves appear in history in order
- [x] Transition name not in the definition → `400 TASK_TRANSITION_NOT_FOUND`
- [x] Transition that exists but is not valid **from the current state** → `409 TASK_TRANSITION_CONFLICT`
- [x] Guarded transition with the guard false → `400 TASK_GUARD_REJECTED`, state unchanged, **no history record appended**
- [x] Setting the guarded payload field then re-firing the same transition succeeds
- [x] `--note "reason"` appears in the history record's `note`
- [x] Transition into a `terminal: true` state → `status` flips to `closed`; both `tasks.transitioned` and `tasks.closed` fire
- [x] Any transition on a **closed** task → `409 TASK_TRANSITION_CONFLICT`

## State is never directly writable

- [x] `PATCH` with a `state` field is rejected by strict-field validation with `VALIDATION_FAILED` / "Unknown field(s): state", before the handler runs, and state is unchanged. The 2026-07-18 pass flagged this as a mismatch against a documented `TASK_STATE_NOT_WRITABLE` ([#605](https://github.com/ttoss/soat/issues/605)); that was resolved by [#613](https://github.com/ttoss/soat/pull/613), which deleted the unreachable code and documented the real behavior. Re-confirmed 2026-07-27: `TASK_STATE_NOT_WRITABLE` no longer appears anywhere in `packages/server/src`
- [x] `update-task` for `title`, `assignee`, `payload` each individually → `200`, only that field changes
- [x] `payload` shallow-merges (other keys preserved) and is re-validated against `payload_schema` (type mismatch → `400 TASK_PAYLOAD_INVALID`)

## Concurrency

- [x] Two conflicting transitions fired near-simultaneously on the same task: exactly one wins; the loser gets `409 TASK_TRANSITION_CONFLICT` unless its transition is also valid from the winner's new state (in which case both apply, serialized). History shows a consistent, ordered chain with no duplicate or skipped `from_state`/`to_state` links

## List / board queries

- [x] `list-tasks --project-id --workflow-id --state --status` returns only matching tasks (the kanban column query); each filter works independently and combined; `assignee` filter works
- [x] Unknown `workflow_id` filter → empty list, **not** all tasks and not an error
- [x] Tasks from another project never appear

## Deletion

- [x] `delete-task` → `200/204`; task gone; `get-task` → `404 TASK_NOT_FOUND`; its history is inaccessible (cascaded)

## Not covered

Nothing outstanding for this resource — the automation, approval-gating, stall,
permission, MCP, and webhook behaviors that also act on tasks are tracked in
[`workflows.md`](./workflows.md) so they are verified once rather than twice.
