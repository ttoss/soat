# PRD: Audit Log

> Generalizes the `ActivityEntry` audit record introduced in
> [guardrails](../packages/website/docs/modules/guardrails.md) — guardrail evaluation records
> become one `detail` kind of the entries defined here; this PRD defines the
> `detail->>'kind'` convention, the kind's schema is owned by the guardrails
> PRD — and provides the activity substrate
> [prd-approvals.md](./prd-approvals.md) assumes.

**Status: fully shipped.** Phase 1 (the `AuditEntry` model, `X-Request-Id`
middleware, write hook, read API, retention sweep), Phase 2 (guardrail
evaluations as a `detail` kind), Phase 3 (read-auditing flag +
`audit.entry_created` webhook), and the per-project NDJSON export are all live
and documented in the
[audit-log module docs](../packages/website/docs/modules/audit-log.md). The
sections below record the decisions each phase settled; only the
[future work](#future-work-not-planned) list remains unbuilt, and it is not
planned.

## Shipped Work

### Phase 2 — Guardrail evaluations as `detail.kind = "guardrail_evaluation"` ✅ Shipped

Decision-changing guardrail evaluations surface as one `detail` kind of the
shipped `AuditEntry` table. This PRD owns only the `detail->>'kind'` convention
such entries must follow; the kind's schema is owned by the guardrails PRD. Live
behavior in the
[audit-log module docs](../packages/website/docs/modules/audit-log.md#system-originated-entries).

**Selective-write (decision 2026-07).** The dedicated `guardrail_evaluations`
table already exists and is the full operational log — one row per guardrail per
call, including plain `execute`. Rather than migrate or dual-write that
high-volume firehose into the mutation-focused audit log, only evaluations that
**changed the call's outcome** (`route_to_approval`, `blocked`, `tripwire`) are
mirrored into `AuditEntry`; `execute` (the identity) stays solely in the
operational table. The mirror is a fire-and-forget write on the shared audit
queue from the single choke point (`persistGuardrailEvaluations`), so all three
dispatch paths — agent tool gate, orchestration tool guardrail, orchestration
engine — are covered, while the dry-run preview (which never persists) produces
no entries. Entries are platform-originated: null principal columns, identified
by `action: guardrails:Evaluate`, with the full evaluation record as `detail`.
The product-feed-ownership question (`AuditEntry.detail` vs a dedicated
`ActivityEntry` model) is **out of scope** here — it is settled by approvals
Phase 4.

**Acceptance criteria (met):**

- ✅ A decision-changing guardrail evaluation writes an `AuditEntry` with
  `detail->>'kind' = "guardrail_evaluation"` and the schema defined by the
  guardrails PRD.
- ✅ A shared schema fixture
  (`packages/server/tests/unit/fixtures/guardrailEvaluationDetail.ts`) keeps the
  guardrails kind and this PRD in lockstep — imported by both the guardrail
  dispatch test (write side, camelCase) and the audit-log test (read side,
  snake_case) — so the `detail` schema cannot drift.

### Phase 3 — Read auditing flag + `audit.entry_created` webhook ✅ Shipped

Live behavior in the audit-log module docs
([read auditing](../packages/website/docs/modules/audit-log.md#read-auditing),
[`audit.entry_created`](../packages/website/docs/modules/audit-log.md#auditentry_created-webhook)).

- **Read auditing** — `audit_reads_enabled` on the
  [project](../packages/website/docs/modules/projects.md), off by default. Reads
  are high-volume and low-value, so the default stays mutations-only; the flag
  opts a single project into recording read actions.
- **`audit.entry_created` webhook event** — emitted from the same
  `writeAuditEntry` choke point that persists the entry, carrying the full
  snake_case entry as its `data` so a SIEM subscriber never needs a follow-up
  `GET`.

**Decision — the flag gates at enqueue, not only at write (2026-07).** The
audit queue is a bounded, fire-and-forget buffer whose capacity is shared with
mutations; letting every `GET` in a read-heavy deployment enter it and be
discarded at write time would let reads evict mutation entries. So the flag is
cached per project (30s TTL, invalidated on project update) and consulted
synchronously *before* enqueue. A cache miss is never a decision: the entry is
enqueued and `writeAuditEntry` — which resolves the project row regardless —
makes the authoritative call, so a cold cache can never lose an opted-in read.

**Decision — a read that names no project is not audited (2026-07).** The flag
is per-project, so an unscoped list enumeration (`GET /secrets` with no
`project_id`) has no project whose flag could opt it in. This falls out of the
shipped middleware's existing rule that the no-id `resolveProjectIds` path is
left unrecorded, and it keeps the design honest: read auditing is a project's
decision, not a global one.

**Acceptance criteria (met):**

- ✅ A project defaults to `audit_reads_enabled: false` and records no read
  entries; flipping it on records `GET`s naming that project with the same
  entry shape as a mutation (action, SRN, `resource_public_id`, status).
- ✅ One project's flag never audits reads of another project, and flipping it
  back off stops recording on the next request.
- ✅ Every persisted project-scoped entry emits `audit.entry_created`; a global
  (`project_id` null) entry emits nothing, since webhooks are project-scoped.
- ✅ Platform-originated entries emit the event with null principal columns.

### Per-project NDJSON export ✅ Shipped

`GET /api/v1/audit-log/export` streams a project's entries as NDJSON — one
snake_case entry per line, oldest first, paged internally so neither server nor
client holds the whole log. Live behavior in the
[audit-log module docs](../packages/website/docs/modules/audit-log.md#ndjson-export).

**Decision — `project_id` is required and the export has its own action
(2026-07).** An unbounded cross-project dump is a materially larger egress
surface than the read API, so the export is per-project by construction rather
than by convention, and is authorized by `audit:ExportAuditEntries` rather than
riding `audit:ListAuditEntries` — granting someone the ability to read the log
should not implicitly grant them the ability to exfiltrate all of it.

**Decision — ascending order (2026-07).** The list endpoint returns newest
first, which is right for a UI but wrong for a paged export: a row written
mid-export would land on page 1 and shift every subsequent page, duplicating a
boundary row. Ordering by `(created_at, id)` ascending appends new rows past
the cursor instead.

**Acceptance criteria (met):**

- ✅ Emits one parseable JSON object per line under `application/x-ndjson`
  with a `Content-Disposition: attachment` filename; every list filter applies
  identically.
- ✅ Pages past the internal batch size without dropping or duplicating rows —
  the exported count matches the list endpoint's `total`.
- ✅ `400` without `project_id`, `401` unauthenticated, `403` for a principal
  holding `audit:ListAuditEntries` but not `audit:ExportAuditEntries`.

## Future work (not planned)

- **Tamper evidence** — hash-chaining entries.
