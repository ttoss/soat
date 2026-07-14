# PRD: Approvals, Exceptions & Activity Feed

- **Status:** Draft v2 — supersedes the node-centric draft
- **Area:** Agent Operations on Formations (G3)
- **Consumes:** run-parking from orchestration (`human` node machinery), guardrail classification
- **Feeds:** learned rules (rejections/edits as candidate-rule signal), activity/audit surfaces

---

## 0. What changed from v1 (and why)

The previous draft treated the `approval` **orchestration node** as the feature and
the queue as its storage. This draft inverts that: **approvals are a centralized
platform module**, and anything that can propose a risky action is a thin
*producer* over it. Two producers ship in v1:

1. **`approval` orchestration node** — declarative placement in a DAG (the v1
   draft's scope, unchanged in behavior).
2. **Tool-call interception** — an `approval_policy` attached to a tool binding,
   so any invocation of a guarded tool creates an approval item and suspends
   execution, *regardless of how the agent was invoked*.

Rationale:

- **The queue is the product, not the node.** Snapshot semantics, server-side
  expiry, reject-with-reason, edit-then-approve with re-classification — all of
  it lives at the item level and is producer-agnostic. Building it into node
  machinery would force a later tool-call producer to duplicate expiry, audit,
  and webhook plumbing.
- **Conversational surfaces are unguarded without tool-call interception.** A
  DAG-resident guardrail protects scheduled cycles only. An agent invoked via a
  chat session, `create-agent-generation`, or an MCP surface never passes
  through the DAG. Today the only defense there is `denied_actions`, which is
  binary. Tool-call approval adds the missing middle state — **allow / ask /
  deny** — enforced at the platform layer. The guardrail stops being only as
  good as the orchestration author.
- **Consistency of the audit story.** One item model, one expiry enforcement
  path, one decision output shape, one re-classification rule. Consumers
  (learned rules, activity feed, webhooks, UIs) never branch on origin.

---

## 1. Module architecture

```
                    ┌──────────────────────────────────────┐
   producers        │        Approvals module (core)       │        consumers
                    │                                      │
 ┌───────────────┐  │  emitApproval(spec) → ApprovalItem   │  ┌───────────────┐
 │ approval node │─▶│  resolveApproval(id, decision)       │─▶│ run resumption│
 └───────────────┘  │  expiry sweeper (server-side)        │  └───────────────┘
 ┌───────────────┐  │  re-classification on edited args    │  ┌───────────────┐
 │ tool-call     │─▶│  dedup / idempotency                 │─▶│ generation    │
 │ interception  │  │  webhooks, activity entries          │  │ continuation  │
 └───────────────┘  │  REST + MCP surface                  │  └───────────────┘
                    └──────────────────────────────────────┘  ┌───────────────┐
                                                              │ learned rules │
                                                              └───────────────┘
```

The core exposes two internal operations:

- **`emitApproval(spec)`** — validates the proposed action against the tool
  schema, resolves and freezes snapshot mappings, applies dedup, persists the
  `ApprovalItem`, emits `approvals.created`, and returns the item plus a
  **suspension handle** the producer uses to park its execution context.
- **`resolveApproval(id, decision)`** — enforces expiry, validates edited
  arguments, runs re-classification, persists the resolution, emits events, and
  invokes the producer-registered **resumption callback**.

Producers differ *only* in their suspension/resumption strategy (§4). Everything
else — lifecycle, expiry, permissions, API, events — is shared.

---

## 2. Implementation status

Phase 1 shipped (approvals queue core + `approval` orchestration node);
Phases 2–4 not started:

- [x] `ApprovalItem` model with lifecycle (`apr_` prefix) — `src/lib/approvals.ts`
- [x] Approvals module core: emit/resolve _(dedup key column exists; dedup logic
      and edit-time re-classification are deferred to Phase 2 / guardrails)_
- [x] `approval` orchestration node type (producer #1)
- [ ] Tool-call interception via `approval_policy` on tool bindings (producer #2)
- [x] Server-side expiry enforcement via scheduler sweeper + execution-path re-check
- [x] Approve / reject / edit-then-approve workflows
- [ ] `ExceptionItem` model with severity routing (`exc_` prefix)
- [ ] `ActivityEntry` feed (`acte_` prefix)
- [x] Webhook events for approvals (`approvals.created` / `.approved` / `.rejected`
      / `.expired`) _(exception events deferred to Phase 3)_
- [x] REST endpoints, OpenAPI specs, permissions

---

## 3. Implementation phases

### Phase 1 — Approvals module + `approval` node + expiry ✅ Done

Convert risky actions into persistent, queryable queue items that cannot execute
after their supporting evidence goes stale.

**Deliverables:**

- Approvals module core (`emitApproval` / `resolveApproval`, dedup, snapshot
  freezing) in `src/lib/approvals.ts`.
- `ApprovalItem` model and lifecycle: `pending → approved | rejected | expired`.
- `approval` node type: emits an item and parks the run as `awaiting_input`;
  resolution re-enqueues the run with the decision output (§6).
- `on_expired` edge routing; unlabeled edges follow on approval only.
- Server-side expiry enforced in **both directions**: the sweeper resolves
  overdue items as `expired`, and the execution path re-checks expiry at
  resolution time to close the race.
- Approve, reject (reason required), and edit-then-approve workflows with
  re-validation and re-classification (§7).
- REST CRUD endpoints with OpenAPI and permissions.

**Unlock:** manage-by-exception operation — agents propose, humans decide from a
queue — for orchestrated (scheduled/DAG) execution.

### Phase 2 — Tool-call approval (`approval_policy` on tool bindings) — Not started

Extend the same queue to *every* execution surface: chat sessions, direct
generations, MCP.

**Deliverables:**

- `approval_policy` on the agent↔tool binding (§5): JSON Logic over the resolved
  tool arguments deciding `allow | require_approval | deny` per call. Evaluated
  by the platform in the tool-dispatch path — not by the model, not by the DAG.
- **Return-pending suspension** for synchronous generations (§4.2): the
  intercepted call returns `{status: "pending_approval", approval_id}` as the
  tool result; the generation completes its turn normally. On resolution, the
  platform re-drives a **continuation generation** with the decision output
  injected as the tool result.
- Dedup/idempotency: an agent retrying a proposal must not spam the queue.
  Dedup key: `(project_id, agent_id, tool_id, args_digest)` while a matching
  item is `pending`; a duplicate emit returns the existing item.
- Same item model, same endpoints, same events — `origin` field distinguishes
  `node` vs `tool_call` for analytics only.

**Unlock:** allow/ask/deny as platform-level enforcement; guardrails hold on
conversational surfaces where no orchestration runs.

### Phase 3 — Exceptions and severity routing — Not started

Failures and anomalies become first-class items, not log lines.

**Deliverables:**

- `ExceptionItem` model, auto-filed by: exhausted node retries, guardrail
  tripwires, expired approvals, and explicit filing operations.
- Severity levels: `info`, `warning`, `critical`.
- Resolution lifecycle: `open → acknowledged → resolved`, with notes.
- Webhook events: `approvals.created`, `approvals.expired`,
  `exceptions.created`.

**Unlock:** hybrid alert routing without polling.

### Phase 4 — Activity feed — Not started

Every autonomous execution visible, for auditability.

**Deliverables:**

- `ActivityEntry` model: one entry per autonomously executed action (both
  producers write through the same module hook).
- Cursor-paginated `GET /api/v1/activity` with type/severity filters.
- Links to originating run/generation, node, agent, and guardrail policy
  version.

**Unlock:** the "what did agents do today" surface.

### Phase 5 — Approver targeting and assignment (future)

Sketch: optional `approver_policy` / `assignees` on the approval node or tool
binding, routing specific items to specific humans. Deferred until real demand.

---

## 4. Suspension & resumption semantics (the hard part)

The two producers share the item lifecycle but suspend differently.

### 4.1 Orchestration runs (`approval` node)

Runs are already durable. The node emits the item and parks the run as
`awaiting_input` exposing `required_action`. Resolution re-enqueues the run;
the decision output (§6) becomes the node result. `on_expired` edges route
expiry; unlabeled edges follow only on approval.

### 4.2 Synchronous generations (tool-call interception) — return-pending

A request/response generation cannot be held open for hours. v1 uses
**return-pending**:

1. The dispatch path evaluates `approval_policy`; on `require_approval` it calls
   `emitApproval` and returns `{status: "pending_approval", approval_id,
   expires_at}` as the tool result.
2. The model sees that result and ends its turn accordingly ("queued for your
   approval") — no special model behavior is required beyond reading the tool
   result.
3. On resolution, the platform triggers a **continuation generation** on the
   same session/conversation, injecting the decision output (§6) as the tool
   result — on approval this includes the actual tool execution result, because
   the platform executes the frozen (or edited) arguments at resolution time.
4. On expiry, the continuation carries `{decision: "expired"}`; the agent
   reports staleness rather than silently re-proposing.

**Explicit non-goal (v1):** durable/parkable generations. Return-pending covers
the product need and matches the manage-by-exception mental model ("the agent
proposed; you'll be notified when it executes"). Durable generations remain a
possible Phase-5+ upgrade with no item-model changes.

**Invariant:** expiry and resolution semantics MUST NOT drift between producers.
The tool path's `{decision: "expired"}` continuation is the exact counterpart of
the node path's `on_expired` edge.

---

## 5. `approval_policy` (tool binding) schema

Attached where an agent binds a tool:

| Property | Type | Description |
|---|---|---|
| `default` | string | `allow` \| `require_approval` \| `deny` — applied when no rule matches. **Fail-closed guidance:** bindings guarding write tools should default to `require_approval` or `deny`. |
| `rules` | array | Ordered; first match wins. |
| `rules[].when` | object | JSON Logic over `{action, arguments}` (resolved call args). |
| `rules[].effect` | string | `allow` \| `require_approval` \| `deny`. |
| `expires_in` | integer | Seconds until item expiry (used when a rule yields `require_approval`). |
| `reasoning_prompt` | string \| null | Optional instruction for the agent to supply reasoning/evidence/predicted-impact alongside guarded calls (attached to the item when provided). |

This is where deterministic action-class policy (A/B/C/D-style classification)
becomes declarative platform config instead of DAG plumbing — the same JSON
Logic used by guardrail `transform` nodes evaluates in the dispatch path.

## 5b. `approval` node template schema

| Property | Type | Description |
|---|---|---|
| `tool_id` | string | Tool the proposed action invokes |
| `arguments` | object | JSON Logic mappings resolved at emit time |
| `expires_in` | integer | Seconds until expiry (matches schedule `grace_seconds` patterns) |
| `instructions` | string \| null | Optional approver guidance |
| `reasoning` | object \| null | JSON Logic mapping for reasoning |
| `evidence` | object \| null | JSON Logic mapping for evidence |
| `predicted_impact` | object \| null | JSON Logic mapping for impact |

**Snapshot semantics (both producers):** all mappings resolve against run/call
state at emit time and freeze onto the item. Later state changes never alter
what the approver sees.

---

## 6. Decision output shape (shared by both producers)

```json
{
  "decision": "approved | rejected | expired",
  "approval_id": "apr_x1y2z3a4b5c6d7e8",
  "resolved_by": "user_a1b2c3d4e5f6g7h8",
  "edited_args": { "amount": 450 },
  "reason": null,
  "result": { "status": "ok" }
}
```

- `decision` — one of the three terminal states.
- `resolved_by` — `null` on expiry.
- `edited_args` — `null` unless edit-then-approve.
- `reason` — required on rejection.
- `result` — tool output on approval; `null` otherwise.

The node receives this as its node result; the continuation generation receives
it as the tool result. **Identical shape — consumers never branch on origin.**

---

## 7. Edit-then-approve: validation and re-classification

Editing arguments before approving triggers:

1. **Re-validation** against the tool's schema.
2. **Re-classification** by the applicable guardrail policy (`approval_policy`
   for tool-call items; the guardrail policy version pinned on the item for node
   items). If the edited args classify to a *higher* action class, a **new**
   approval item is created instead of resolving the current one — preventing
   approval-time privilege escalation.

Rejection requires a reason; edits preserve the diff. Both feed the learned-rules
pipeline as candidate-rule signal.

---

## 8. Expiry as hard enforcement

Evidence goes stale. Expiry is enforced server-side **in both directions**:

- The scheduler sweeper resolves overdue `pending` items as `expired` and emits
  `approvals.expired`.
- The resolution/execution path re-checks `expires_at` at decision time, closing
  the sweep-vs-approve race. An expired item can never execute, even if a
  human clicks approve a millisecond after expiry.

---

## 9. Data models

### ApprovalItem

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `apr_` prefix |
| `project_id` | string | Owning project |
| `origin` | string | `node` \| `tool_call` (analytics/filtering only) |
| `status` | string | `pending`, `approved`, `rejected`, `expired` |
| `proposed_action` | object | Tool ID and frozen arguments |
| `reasoning` | string \| null | Agent's rationale |
| `evidence` | object \| null | Supporting structured data |
| `predicted_impact` | string \| null | Expected execution effect |
| `expires_at` | string | Server-enforced hard gate |
| `dedup_key` | string \| null | Set on tool-call items (§3 Phase 2) |
| `run_id` / `generation_id` / `node_id` / `agent_id` | string \| null | Provenance (producer-dependent) |
| `knowledge_version` / `policy_version` | string \| null | Context versions |
| `resolved_by` | string \| null | Resolving user (`null` on expiry) |
| `resolution_reason` | string \| null | Required on rejection |
| `edited_arguments` | object \| null | Set on edit-then-approve |
| `created_at` / `updated_at` | string | Timestamps |

### ExceptionItem

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `exc_` prefix |
| `project_id` | string | Owning project |
| `status` | string | `open`, `acknowledged`, `resolved` |
| `severity` | string | `info`, `warning`, `critical` |
| `kind` | string | `run_failed`, `guardrail_tripwire`, `approval_expired`, `manual` |
| `title` / `detail` | string | Human-readable and structured |
| `run_id` / `node_id` / `agent_id` | string \| null | Provenance |
| `resolved_by` / `resolution_note` | string \| null | Resolution audit |
| `created_at` / `updated_at` | string | Timestamps |

### ActivityEntry

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `acte_` prefix |
| `project_id` | string | Owning project |
| `kind` | string | `action_executed`, `approval_resolved`, `exception_created`, `schedule_fired` |
| `summary` | string | One-line description |
| `detail` | object \| null | Tool, args digest, policy version |
| `run_id` / `agent_id` / `ref_id` | string \| null | Provenance |
| `created_at` | string | Append-only timestamp |

**Indexing:** `(project_id, status, expires_at)` on ApprovalItem, plus a unique
partial index on `dedup_key` where `status = 'pending'`; `(project_id, status,
severity)` on ExceptionItem; `(project_id, created_at DESC)` on ActivityEntry.

---

## 10. Authorization model (v1)

Any principal with `approvals:ResolveApproval` in the project may resolve any of
the project's items — no per-item targeting until real demand emerges (Phase 5).
Approval items are platform-created only; there is no public create endpoint.

| Permission | Endpoint |
|---|---|
| `approvals:ListApprovals` | `GET /api/v1/approvals` |
| `approvals:GetApproval` | `GET /api/v1/approvals/{approval_id}` |
| `approvals:ResolveApproval` | approve and reject endpoints |
| `exceptions:ListExceptions` | `GET /api/v1/exceptions` |
| `exceptions:ResolveException` | `POST /api/v1/exceptions/{exception_id}/resolve` |
| `activity:ListActivity` | `GET /api/v1/activity` |

---

## 11. REST API

| Method | Path | Function |
|---|---|---|
| GET | `/api/v1/approvals` | List/filter by status, project, expiry, origin |
| GET | `/api/v1/approvals/{approval_id}` | Full item with evidence |
| POST | `/api/v1/approvals/{approval_id}/approve` | Approve, optional edited arguments |
| POST | `/api/v1/approvals/{approval_id}/reject` | Reject, reason required |
| GET | `/api/v1/exceptions` | List/filter by status, severity |
| POST | `/api/v1/exceptions/{exception_id}/resolve` | Acknowledge/resolve with note |
| GET | `/api/v1/activity` | Cursor-paginated project feed |

**MCP integration:** tools (`list-approvals`, `approve-approval`,
`reject-approval`, `list-exceptions`, `resolve-exception`, `list-activity`)
auto-generate from OpenAPI — external assistants get the same queue surface as
product UIs.

---

## 12. Open questions

1. **Continuation trigger surface** — on resolution of a tool-call item, is the
   continuation generation fired automatically, or exposed as an event the
   client app drives? (Recommend: platform-automatic, with a webhook for UIs.)
2. **Dedup window on non-pending states** — should a proposal identical to a
   *recently rejected* item be suppressed or auto-filed as an exception?
   (Recommend: allow re-proposal but attach `previous_item_id` so approvers see
   the history; repeated rejection is itself learned-rule signal.)
3. **`deny` effect UX** — a policy `deny` on a tool call returns a structured
   refusal to the model; should it also write an ActivityEntry? (Recommend: yes,
   `kind: action_denied`, for the audit trail.)
