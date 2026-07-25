# PRD: Audit Log

> Generalizes the `ActivityEntry` audit record introduced in
> [guardrails](../packages/website/docs/modules/guardrails.md) — guardrail evaluation records
> become one `detail` kind of the entries defined here; this PRD defines the
> `detail->>'kind'` convention, the kind's schema is owned by the guardrails
> PRD — and provides the activity substrate
> [prd-approvals.md](./prd-approvals.md) assumes.

Phase 1 has shipped (see the [audit-log module docs](../packages/website/docs/modules/audit-log.md)
for the shipped `AuditEntry` model, `X-Request-Id` middleware, write hook, read
API, and retention sweep). The `detail` JSONB column already exists and is
keyed by a `detail->>'kind'` convention; every pending item below extends that
substrate.

## Pending Work

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

### Phase 3 — Read auditing flag + `audit.entry_created` webhook ❌ Not started

- **Read auditing** — a per-project config flag, off by default. Reads are
  high-volume and low-value, so v1 records mutations only; the flag opts a
  project into recording read actions when needed.
- **`audit.entry_created` webhook event** — emitted through the existing
  webhooks module so external systems (e.g. SIEM) can subscribe to new audit
  entries.

### Per-project NDJSON export ❌ Not started

A dedicated export path that streams a project's audit entries as NDJSON.
Today the only route is paginating the list endpoint by hand; this adds a
first-class per-project export.

## Future work (not planned)

- **Tamper evidence** — hash-chaining entries.
