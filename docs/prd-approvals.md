# PRD: Approvals, Exceptions & Activity Feed

> Status and sequencing live in the [SOAT Delivery Roadmap](./roadmap.md).

- **Status:** Draft v2 — supersedes the node-centric draft
- **Area:** Agent Operations on Formations (G3)
- **Consumes:** run-parking from orchestration (`human` node machinery), guardrail classification
- **Feeds:** guardrail graduation (recurring rejections surfaced by the recurrence view become `deny` candidates), activity/audit surfaces; rejection/edit signal stays persisted on items for the deferred [learned-rules module](./prd-learned-rules.md)

---

## Implementation status (remaining)

Phase 1 (approvals queue core + `approval` orchestration node) and Phase 3 (the
exceptions queue) have shipped; Phase 2's per-binding `approval_policy` was
superseded by the [guardrail](../packages/website/docs/modules/guardrails.md)
interceptor (G4) and removed. Dedup is now complete: a duplicate emit returns the
existing pending item, and a re-proposal matching a *rejected* item is admitted
with `previous_item_id` linking the prior item (decision 2). Outstanding:

- [x] Recurrence view (`GET /api/v1/approvals/recurrences`) — folded in from the deferred learned-rules module (2026-07); shipped. Live behavior in the [approvals module docs](../packages/website/docs/modules/approvals.md#recurrence-view)
- [ ] `ActivityEntry` feed (`acte_` prefix)

---

## Remaining work

### Dedup / idempotency — shipped

An agent retrying a proposal must not spam the queue. Dedup key:
`(project_id, agent_id, tool_id, args_digest)`. While a matching item is
`pending`, a duplicate emit returns the existing item rather than creating a new
one — the `emitApproval` fast path plus a create-time unique-violation backstop
(the partial unique index where `status = 'pending'`) resolve the race to the
single pending winner.

Non-pending states follow decision 2 below: a re-proposal matching a *rejected*
item is **admitted** (not suppressed) with `previous_item_id` linking the prior
item, so approvers see the recurrence and the learned-rules rejection signal is
preserved. `previousItemId` is stamped by `emitApproval` (most-recent rejected
match for the key) and surfaced on the REST/MCP item shape.

### Recurrence view — Shipped

Live behavior is documented in the [approvals module docs](../packages/website/docs/modules/approvals.md#recurrence-view).
The design intent below is retained for context.

A read-only aggregate over the queue answering "what keeps coming back?" — the
rollup of the per-item `previous_item_id` chains that dedup (decision 2)
already threads. Folded into this module when the learned-rules module was
deferred (see [roadmap → Deferral: learned rules](./roadmap.md#deferral-learned-rules)):
every input is already a column on `ApprovalItem` (`dedup_key`,
`previous_item_id`, `resolution_reason`, `edited_arguments`), so recurrence
surfacing is a queue read surface, not a new resource.

**Deliverables:**

- `GET /api/v1/approvals/recurrences` — groups items by `dedup_key`
  (`project_id` required; `status` filter, default `rejected`; `min_count`,
  default 2; paginated). Each group returns `dedup_key`, `agent_id`,
  `tool_id`, `count`, the ordered item chain (via `previous_item_id`), and the
  rejection reasons in order — a human reading three rejection reasons side by
  side *is* the curation step, without a curation lifecycle.
- Permission `approvals:ListApprovalRecurrences`; OpenAPI spec + regenerated
  SDK/CLI (MCP tool derives automatically).

**Constraints (scope guard):**

- **Read-only.** No cluster statuses, no "mark as handled", no assignments —
  any write-side lifecycle here would be the deferred learned-rules module
  rebuilt through the back door.
- **Exact-key grouping only.** Semantic (embedding) clustering of paraphrased
  corrections stays with the deferred learned-rules module — it would couple
  this deliberately deterministic module to an AI-provider dependency.

**Unlock:** "this exact proposal has been rejected 4 times" as a queryable
fact — the graduation prompt for encoding a
[guardrail](../packages/website/docs/modules/guardrails.md) `deny`, which
stops the recurrence upstream. Whether humans act on this surface is the
demand signal that decides if the full learned-rules module ever gets built.

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

### In-channel approval clients (future)

Surface approval items — and let humans resolve them — directly inside
conversational channels (chat sessions, external assistant surfaces) rather than
only through the queue UI/API. The continuation-trigger surface these clients
build on is settled (decision 1 below: platform-automatic, observed via the
lifecycle webhook); if a channel client needs client-controlled continuation
timing (defer/batch), that extension is scoped here, not in the core loop.

---

## Data model (pending)

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

**Indexing:** `(project_id, created_at DESC)` on ActivityEntry.

---

## Authorization (pending)

| Permission | Endpoint |
|---|---|
| `approvals:ListApprovalRecurrences` | `GET /api/v1/approvals/recurrences` |
| `activity:ListActivity` | `GET /api/v1/activity` |

---

## REST API (pending)

| Method | Path | Function |
|---|---|---|
| GET | `/api/v1/approvals/recurrences` | Read-only `dedup_key` recurrence groups (chain, count, ordered reasons) |
| GET | `/api/v1/activity` | Cursor-paginated project feed |

**MCP integration:** the `list-activity` tool auto-generates from OpenAPI once
the endpoint exists — external assistants get the same feed surface as product
UIs.

---

## Decisions (formerly open questions)

1. **Continuation trigger surface — resolved (shipped).** The continuation is
   platform-automatic: the decision is persisted and its lifecycle webhook
   emitted first, then the continuation fires fire-and-forget so the resolve
   request returns promptly (`agentToolApprovalContinuation.ts`).
   Server-executable tools run at resolution time through the persisted-tool
   path; client tools are re-handed off to the client via a fresh linked
   generation instead of executing server-side. UIs observe through the
   lifecycle webhook — they get a notification, not a control point.
   Client-driven continuation timing is deliberately out of the core loop (see
   in-channel approval clients above).

2. **Dedup window on non-pending states — resolved: allow re-proposal, thread
   the history.** A proposal identical to a *recently rejected* item is neither
   suppressed nor auto-filed as an exception; it is admitted with
   `previous_item_id` linking the prior item so approvers see the recurrence.
   Rationale: every rejection is a learned-rules capture event
   (`source_kind: approval_rejected` in
   [prd-learned-rules.md](./prd-learned-rules.md)), and suppression would
   starve the recurrence signal that makes the pattern stop recurring — while
   also silently blocking legitimate re-proposals whose context changed.
   Recurrence *aggregation* has since moved into this module (revised 2026-07,
   when the learned-rules module was deferred): the read-only
   [recurrence view](#recurrence-view--not-started) rolls up exact-`dedup_key`
   chains using nothing beyond columns this module already owns. Semantic
   clustering of *paraphrased* corrections remains outside, with the deferred
   learned-rules module. Spam is bounded structurally: pending-state
   dedup catches tight retry loops, and rejected-state re-proposals are
   rate-limited by human decision cadence. What happens *after* recurrence is
   detected is a human call the recurrence view informs — encode a hard
   guardrail `deny` to stop the pattern upstream, or keep deciding per item;
   soft context rules stay deferred with the learned-rules module.

3. **`deny` effect audit record — resolved: yes, on the audit substrate.** A
   policy `deny` on a tool call writes an audit record with
   `detail->>'kind' = 'action_denied'` on the shipped `AuditEntry` table
   ([audit-log module docs](../packages/website/docs/modules/audit-log.md)) —
   not on the pending
   `ActivityEntry` model this PRD previously assumed. A deny is a
   security-relevant event and belongs in the audit trail unconditionally;
   feed noise is a non-issue because the product activity surface filters by
   kind/severity. This is consistent with the roadmap's activity-feed
   reconciliation direction (audit-shaped kinds land on `AuditEntry`); the
   broader question of which model owns the Phase 4 product feed remains
   tracked in the [roadmap](./roadmap.md#cross-cutting-reconciliations).
