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
- [x] `ActivityEntry` feed (`acte_` prefix) — shipped (2026-07). Live behavior in the [activity module docs](../packages/website/docs/modules/activity.md)
- [x] `action_executed` at agent-generation time — the v1 gap decision 4 recorded as follow-up; closed (2026-07). Live behavior in the [activity producers docs](../packages/website/docs/modules/activity.md#producers)
- [x] `soat.activity.actions_1h` / `actions_24h` guard context — closed (2026-07); the keys were in the guardrail allowlist and documented but nothing populated them. Live behavior in [the feed as a guardrail signal](../packages/website/docs/modules/activity.md#the-feed-as-a-guardrail-signal)

Every deliverable in this PRD has shipped. What remains is deferred by design,
not outstanding: **Phase 5** (approver targeting and assignment) and
**in-channel approval clients**, both gated on a demand signal that has not
arrived — see the sections below.

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

### Phase 4 — Activity feed — Shipped

Every autonomous execution visible, for auditability. Live behavior in the
[activity module docs](../packages/website/docs/modules/activity.md).

**Deliverables:**

- `ActivityEntry` model: one entry per autonomously executed action, written
  through a single shared module hook (`emitActivityEntry`) regardless of
  producer.
- Cursor-paginated `GET /api/v1/activity` with `kind`/`severity` filters.
- `run_id` / `agent_id` as top-level provenance columns; node id, generation
  id, and guardrail policy version carry in `detail` instead (decision 4).

**Unlock:** the "what did agents do today" surface.

**The v1 gap is closed (2026-07).** `action_executed` was originally instrumented
only at the orchestration tool-node executor; agent-generation-time tool calls
were not, because the agent identity was thought not to be threaded through that
call path. It effectively already was: the resolver receives a
`ResolverGuardrailContext` carrying `agentId` / `generationId` / `runId`, built at
the generation entry point. Rather than overload that (a guardrail context the
feed would then depend on), a sibling `ActivityCallContext` is threaded the same
way, and the recording wrapper sits **innermost** — inside the guardrail
interceptor and after the tool returns — so an entry means the action really ran:
blocked, tripped, approval-routed, and failed calls record nothing. Callers with
no agent in scope (the orchestration path) pass no context and never
double-record. Client tools stay uninstrumented by design: with no server-side
execution the platform cannot attest the action happened.

**Activity as a guardrail signal (task 5.4, closed 2026-07).**
`soat.activity.actions_1h` / `actions_24h` resolve from the feed at evaluation
time — the count of this project's `action_executed` entries in the rolling
window — so a guard can cap the autonomous-action rate. The keys had been in the
guardrail var allowlist and the docs since Phase 4 with nothing populating them,
which made any guard written against them fail closed permanently: not a security
hole (fail-closed is the safe direction) but a dead feature. Only
`action_executed` counts, and an empty feed reads as a real `0` rather than
unresolved — "this project has taken no actions" is a meaningful zero, unlike the
per-run usage keys read outside a run.

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

## Data model — shipped

### ActivityEntry

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Public ID, `acte_` prefix |
| `project_id` | string | Owning project |
| `kind` | string | `action_executed`, `approval_resolved`, `exception_created`, `schedule_fired` |
| `severity` | string | `info`, `warning`, `critical` (per-kind default; decision 4) |
| `summary` | string | One-line description |
| `detail` | object \| null | Tool, args digest, node id, generation id, guardrail policy version |
| `run_id` / `agent_id` / `ref_id` | string \| null | Provenance (bare public ids, no FK — decision 4) |
| `created_at` | string | Append-only timestamp |

**Indexing:** `(project_id, created_at)` and `(project_id, created_at, public_id)`
(keyset-pagination tiebreaker) on ActivityEntry.

---

## Authorization — shipped

| Permission | Endpoint |
|---|---|
| `approvals:ListApprovalRecurrences` | `GET /api/v1/approvals/recurrences` |
| `activity:ListActivity` | `GET /api/v1/activity` |

---

## REST API — shipped

| Method | Path | Function |
|---|---|---|
| GET | `/api/v1/approvals/recurrences` | Read-only `dedup_key` recurrence groups (chain, count, ordered reasons) |
| GET | `/api/v1/activity` | Cursor-paginated project feed |

**MCP integration:** the `list-activity` tool auto-generates from OpenAPI —
external assistants get the same feed surface as product UIs.

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
   policy `deny` on a tool call writes an audit record on the shipped
   `AuditEntry` table
   ([audit-log module docs](../packages/website/docs/modules/audit-log.md)) —
   not on the pending `ActivityEntry` model this PRD previously assumed. The
   denial is recorded as an ordinary entry whose `status` is `403` and whose
   primary `action` is the check that failed (see `selectPrimaryIndex` in
   `middleware/audit.ts`); there is **no** `detail.kind = 'action_denied'`
   marker — earlier revisions of this decision and of the roadmap asserted one,
   which was never implemented. A deny is a
   security-relevant event and belongs in the audit trail unconditionally;
   feed noise is a non-issue because the product activity surface filters by
   kind/severity. This is consistent with the roadmap's activity-feed
   reconciliation direction (audit-shaped kinds land on `AuditEntry`); the
   broader question of which model owns the Phase 4 product feed remains
   tracked in the [roadmap](./roadmap.md#cross-cutting-reconciliations).

4. **Phase 4 activity-feed ownership and schema gaps — resolved (2026-07),
   shipped.** The roadmap's cross-cutting reconciliation asked which model
   owns the Phase 4 product feed: fold it into the shipped `AuditEntry`, or
   ship the PRD's own `ActivityEntry`. Decided: a new `ActivityEntry` model,
   per the user's explicit choice — `AuditEntry`'s `action` field is
   documented as *the permission-action string that authorized the request*,
   and none of the four activity kinds (`action_executed`,
   `approval_resolved`, `exception_created`, `schedule_fired`) is an
   authorization event; folding them in would have required bolting
   `agent_id`/`run_id` provenance onto a compliance-grade, append-only audit
   table that customers already pipe to SIEMs, mixing high-volume operational
   telemetry into a security-review surface. This sub-decision was forwarded
   rather than self-resolved because it fixes a public REST/schema contract
   (the open-questions gate's high-risk class always forwards those).
   Implementing it surfaced sub-gaps, resolved on the spot (Pareto/long-term
   tests, not forwarded — none is security/auth/billing/deletion/migration or
   a genuine trade with no dominant option):
   - **Q: the deliverables ask for a `severity` filter, but the PRD's own data
     model table had no `severity` column — real gap or documentation nit?**
     A: added `severity` (`info`/`warning`/`critical`, per-kind default) —
     resolved by Pareto; reuses [Exceptions](../packages/website/docs/modules/exceptions.md#severity)'s
     existing enum verbatim, so it's consistent rather than a third
     convention, and nothing else changes.
   - **Q: cursor pagination has no precedent anywhere in this codebase (every
     other list endpoint is offset/limit) — design it, or fall back to
     offset?** A: real keyset pagination, opaque `base64url(created_at|id)`
     cursor — resolved by Pareto; offset would silently contradict the PRD's
     explicit "cursor-paginated" deliverable on a high-volume, append-only
     feed where an offset page shifts under concurrent writes.
   - **Q: `run_id`/`agent_id`/`guardrail_version` have three inconsistent
     shapes across sibling models (bare string on `ExceptionItem`, FK on
     `ApprovalItem.orchestrationRunId`, raw int vs. composite string for
     guardrail version) — which does `ActivityEntry` follow?** A: bare public
     ids, matching `ExceptionItem` — resolved by the long-term test (pattern
     hygiene: don't add a fourth convention); node id, generation id, and
     guardrail policy version live in `detail` instead of dedicated columns,
     since the feed has no resolution workflow needing to join back to those
     rows (same reasoning as Exceptions).
   - **Q: which call sites should emit `action_executed`, given `callTool()`
     itself turned out not to be a safe single hook (some of its ~9 callers
     are guardrail-context/converter evaluation, not real autonomous
     execution)?** Forwarded to the user; no response arrived, so scoped down
     under the long-term test (debt containment: a visible, documented,
     bounded gap beats silently expanding into a widely-shared low-level
     resolver without a check on blast radius) to the one clean call site —
     the orchestration tool-node executor. Recorded as the "known v1 gap"
     above rather than left unshipped or forced into a wider, unverified
     change. **Resolved since (2026-07):** the answer was neither `callTool()`
     nor its callers but the *resolver* — `resolveAgentTools`, the single seam
     every agent-generation tool passes through on its way to becoming an
     executable tool. Wrapping there (innermost, inside the guardrail gate)
     reaches every agent tool call without touching `callTool`'s
     guardrail-context and converter-evaluation callers at all, which is what
     made the blast radius checkable.
