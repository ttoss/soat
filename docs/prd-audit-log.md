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

### Phase 2 — Guardrail evaluations as `detail.kind = "guardrail_evaluation"` ❌ Not started

Land the guardrails `ActivityEntry` as one `detail` kind of the shipped
`AuditEntry` table rather than a parallel table. This PRD owns only the
`detail->>'kind'` convention such entries must follow; the kind's schema is
owned by the guardrails PRD.

**Blocked on:** guardrails G4 Phase 3.

**Acceptance criteria:**

- A guardrail evaluation writes an `AuditEntry` with
  `detail->>'kind' = "guardrail_evaluation"` and the schema defined by the
  guardrails PRD.
- A shared schema fixture in tests keeps the guardrails kind and this PRD in
  lockstep so the `detail` schema cannot drift.

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
