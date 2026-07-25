# Mode: plan

Turn a task into a small, verifiable, bounded plan before any code.

Steps: restate the task; run the Light baseline to reconcile the task against existing repo rules/contracts (`reference/baseline.md`) so the plan can't silently contradict a `CLAUDE.md`/`.claude/rules` rule; identify relevant files, contracts, tests, boundaries; derive the 1–3 axes native to this change's decision space (fill `### Axes`; write "none — trivial" if the change has no decision space) and put scope along them — parametrize over the axis, don't branch per case; define scope + non-goals; classify risk with the skill's vocabulary — **high-risk class** (→ propose, no autonomy) and/or **architecture/product ambiguity** (→ needs human judgment), else routine; define required tests/commands; surface blocking questions; when a human answer resolves one with a decision that will recur (a rule or durable intent — not a one-off choice), record it under `### Open questions` as `decided: <rule> → codify at <surface>` (smallest correct surface — stewardship table, `reference/methodology.md`, read on demand) so the next session inherits a constraint, not a question — propose only (Action axis); produce plan + implementation prompt.

```md
### Verdict READY | NEEDS_CLARIFICATION | TOO_RISKY_FOR_DIRECT_IMPLEMENTATION

### Task understanding

### Risk routine, or high-risk-class and/or architecture/product-ambiguity + reason

### Relevant files and contracts

### Axes

### Scope

### Non-goals

### Required tests and verification

### Open questions

### Implementation plan

### Implementation prompt
```

## Example

Task: "add CSV export to the invoices table."

```md
### Verdict READY

### Task understanding
Add a "Download CSV" action that exports the currently-filtered invoice rows.

### Risk routine + reason
No high-risk-class surface (no billing mutation, no auth change); read-only export of already-visible data.

### Relevant files and contracts
`src/invoices/InvoiceTable.tsx` (renders rows), `src/invoices/useInvoices.ts` (filter state),
existing `src/lib/csv.ts` (reuse — do not write a new serializer).

### Axes
row-set → serialized format, owned by `csv.ts` — no per-column branching; the filter state is the single input.

### Scope
Serialize the in-memory filtered rows via `csv.ts`; wire one button.

### Non-goals
Server-side export; new columns; changing the filter model.

### Required tests and verification
Unit test: filtered rows → expected CSV string (incl. comma/quote escaping). `pnpm test --filter invoices`.

### Open questions
None blocking.

### Implementation plan
1. `toCsv(rows)` in `csv.ts` if missing. 2. Button calls it on current rows. 3. Test escaping.

### Implementation prompt
"Reuse src/lib/csv.ts; export the filtered rows from useInvoices; add an escaping unit test."
```
