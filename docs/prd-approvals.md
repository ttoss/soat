# PRD: Approvals, Exceptions & Activity Feed

> Status and sequencing live in the [SOAT Delivery Roadmap](./roadmap.md).

- **Status:** Draft v2 — supersedes the node-centric draft
- **Area:** Agent Operations on Formations (G3)
- **Consumes:** run-parking from orchestration (`human` node machinery), guardrail classification
- **Feeds:** learned rules (rejections/edits as candidate-rule signal), activity/audit surfaces

---

## Implementation status (remaining)

Phase 1 (approvals queue core + `approval` orchestration node) and Phase 3 (the
exceptions queue) have shipped; Phase 2's per-binding `approval_policy` was
superseded by the [guardrail](../packages/website/docs/modules/guardrails.md)
interceptor (G4) and removed. Outstanding:

- [ ] Dedup: a duplicate emit returns the existing pending item _(the `dedup_key`
      column and unique partial index exist; the return-existing logic is not yet wired)_
- [ ] Knowledge-version provenance on approval items
- [ ] `ActivityEntry` feed (`acte_` prefix)

---

## Remaining work

### Dedup / idempotency — return-existing (pending)

An agent retrying a proposal must not spam the queue. Dedup key:
`(project_id, agent_id, tool_id, args_digest)` while a matching item is
`pending`; a duplicate emit returns the existing item rather than creating a new
one. The `dedup_key` column and its unique partial index (where
`status = 'pending'`) already exist; the return-existing behavior in
`emitApproval` is not yet implemented.

### Knowledge-version provenance (pending)

Populate and expose `knowledge_version` / `policy_version` on approval items so
approvers can trace which knowledge and guardrail-policy versions a proposal was
based on. Emit-time freezing must capture these alongside the snapshot mappings,
and the fields must be surfaced through the REST/MCP item shape.

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
only through the queue UI/API. Depends on the continuation-trigger decision
below (open question 1).

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
| `activity:ListActivity` | `GET /api/v1/activity` |

---

## REST API (pending)

| Method | Path | Function |
|---|---|---|
| GET | `/api/v1/activity` | Cursor-paginated project feed |

**MCP integration:** the `list-activity` tool auto-generates from OpenAPI once
the endpoint exists — external assistants get the same feed surface as product
UIs.

---

## Open questions

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
