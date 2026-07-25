# Mode: review

Use after implementation, before commit. Steps:

1. Apply the trivial fast path first (`SKILL.md` Scope control).
2. Run the Light baseline; escalate to Deep per the triggers in `reference/baseline.md`. Record the choice and trigger for Coverage.
3. Large diff (>~15 files or >~800 changed lines): list every changed file, group by package/domain, review group by group. The same rule violated in N places → one finding; list all instances under Evidence; anchor the key at the owning rule/config where one exists.
4. Review the relevant dimensions (`reference/methodology.md`, incl. the relevance rule); on instruction surfaces apply the instruction-artifact syndromes; flag basis-form drift in both directions (case-enumeration where an axis is visible; empty/speculative axis — `reference/basis-form.md`); reconcile touched rules (`reference/baseline.md`).
5. Classify with the SKILL finding format (headline + detail tier, incl. fix-class and `Key:`); render per **Output discipline** (SKILL: strict severity order, P1 capped at top 3 full + rest one-line, P2/P3 one line each); note missing verification; write a correction prompt.
6. End the Summary with `reviewed N/N changed files`; name any unreviewed file under Missing verification — never sample silently.
7. On a PASS-class verdict (`PASS`/`PASS_WITH_FIXES`/`PASS_WITH_ACCEPTED_RISK`), append `### PR package`: suggested title + description sourced from the Summary, the verification evidence, and reviewer focus (risks + non-goals). Prepare, never approve; omit the section on `BLOCK`.

```md
### Verdict PASS | PASS_WITH_FIXES | PASS_WITH_ACCEPTED_RISK | BLOCK

### Summary (ends with `reviewed N/N changed files`)

### Coverage Light|Deep (trigger) · dimensions checked: <slugs> / skipped: <slugs> (reason)

### Required fixes [P0/P1][dominant|trade][G-###][dimension][rung] title + detail tier (SKILL finding format; P0 first, then P1 — top 3 full, rest one-line) ...

### Suggested improvements [P2/P3][dominant|trade][G-###][dimension][rung] title — one line each, or counts per dimension when >~5 ...

### Missing verification

### Docs/instructions impact

### PR package (PASS-class verdicts only) title · description · verification evidence · reviewer focus

### Correction prompt
```

## Example

Diff adds a permission check but no test.

```md
### Verdict BLOCK

### Summary
New `canDelete()` gate on the delete route — permission behavior altered (high-risk class) with no test: unverified critical behavior. Reviewed 3/3 changed files.

### Coverage
Deep (high-risk domain) · dimensions checked: verification-loop, boundary-integrity, executable-spec / skipped: co-located-spec, compressibility, pattern-hygiene, debt-containment, instruction-hygiene (no artifact touched)

### Required fixes
[P0][dominant][G-001][verification-loop][enforcement] Permission gate altered with no test
  fix: add allow/deny unit tests + gate in CI  ·  src/auth/canDelete.ts:42
  Key: src/auth/canDelete.ts:canDelete:verification-loop:missing-test
  why: `canDelete` added, no test touched (`pnpm test --filter auth` covers no case); a future refactor silently opens the delete route — human review is the only sensor.
  basis: checked — test-only addition, no runtime surface; the CI gate still stops per the Action axis. To ship without: explicit human acceptance → PASS_WITH_ACCEPTED_RISK.

### Suggested improvements
[P2][trade][G-002][boundary-integrity][enforcement] Delete route imports the DB client directly — Key: src/routes/delete.ts:handler:boundary-integrity:layer-bypass (consider an import-restriction rule)

### Missing verification
`pnpm test --filter auth` (add the allow/deny cases above).

### Docs/instructions impact
None.

### Correction prompt
"Add allow/deny tests for canDelete, wire the auth suite into CI, then re-run /guardian review. To ship without them, record explicit acceptance (who/why/expiry) → PASS_WITH_ACCEPTED_RISK."
```
