# Mode: audit

Bounded health review; require a scope (ask if missing). Probe first — files and volume: `git ls-files <scope> | wc -l` and `git ls-files <scope> | xargs wc -l | tail -1`. The bound is the **exhaustive contract** — every file read, every syndrome applied, all 8 dimensions scored with a cited check — not a fixed count; beyond ~100 files or ~30k total lines the contract degrades silently (heuristics; the human may override): propose 2–4 sub-scopes by seam (package/layer/domain) — interactive: offer them as a menu (`reference/bindings.md`) — and audit one. Narrowing trades holism for depth: the syndromes that live **between** sub-scopes — duplication across them (irreducible), dependency cycles between them (orthogonal) — are invisible to every sub-audit. So when narrowing, still run any repo-wide mechanical check the repo already has (duplication detector, import/dependency-graph lint) at full width, and record cross-scope checks not run under Coverage. Steps:

1. Run the Deep baseline (`reference/baseline.md`); disposition every item (`enforced`/`prose-only`/`absent`).
2. Enumerate every file in scope; apply the applicable syndrome set to each — code: the crosswalk checks (`reference/basis-form.md`); instruction surfaces incl. skill files: the instruction-artifact syndromes (`reference/methodology.md`). When the scope is itself an instruction artifact, its files are the surface set for reconciliation.
3. Score **all 8 dimensions**, one row each: examined → score + the cited performed check (command run, per-file sweep, claim diff) and its result; not examined → `UNKNOWN` + one-word reason. No cited check → `UNKNOWN`, never `GOOD`. Omitted rows are not allowed.
4. Reconcile declared-vs-enforced; check boundary enforcement.
5. List findings in the SKILL finding format (incl. `Key:`); propose a safe sequence.

Output — render findings per SKILL **Output discipline** (every P0 full; P1 top 3 full, each extra as a one-line finding; P2/P3 one line each, or counts per dimension when >~5); never hide blockers; name the first safe improvement as a runnable command.

```md
### Verdict AUDIT_BACKLOG

### Scope audited

### Coverage files read · checks applied · explicitly not checked

### Baseline every item dispositioned enforced / prose-only / absent, where enforcement runs

### AI Repo score | Dimension | Score (GOOD/WEAK/BAD/UNKNOWN) | Evidence (cited check + result, or UNKNOWN reason) | — all 8 rows

### Findings all P0s · top-3 P1s in full (SKILL finding format: headline + detail tier, incl. `Key:`)

### Cut findings every cut P1 as one line `[P1][dominant|trade][G-###][dim][rung] title — Key: ...` · P2/P3 one line each, or counts per dimension when >~5

### Suggested sequence

### First safe improvement (a runnable `/guardian improve <ref>` command)

### Do-not-touch without approval
```

## Example

Scope `src/payments` (a slice — a full `src/` would be narrowed first via the probe).

```md
### Verdict AUDIT_BACKLOG

### Scope audited
src/payments (probe: 14 files, 2.1k lines)

### Coverage
Read 14/14 files; checks: per-file syndrome sweep, tsc config resolved, CI workflow read, claim diff CLAUDE.md vs scripts. Not checked: runtime behavior (no focused check exists — proposed as a follow-up).

### Baseline
Enforced: strict TS (tsconfig), lint (CI). Prose-only: "always use money integers" (CLAUDE.md) — no check. Absent: pre-commit hooks, coverage gate. Instruction surfaces: root CLAUDE.md only — no others found.

### AI Repo score
| Dimension | Score | Evidence |
| compressibility | GOOD | per-file sweep: max file 210 lines, no cross-layer logic |
| executable-spec | WEAK | "money integers" rule prose-only (claim diff vs enforcement) |
| co-located-spec | GOOD | totals.spec.md present, states non-goals |
| verification-loop | BAD | focused check: none for totals path |
| boundary-integrity | GOOD | import sweep: payments never imported outside its package |
| pattern-hygiene | UNKNOWN | not-swept (time-boxed; propose follow-up) |
| debt-containment | GOOD | 1 TODO, visible and issue-linked |
| instruction-hygiene | GOOD | syndrome pass on CLAUDE.md: no hits |

### Findings
[P0][dominant][G-001][verification-loop][enforcement] Float arithmetic on money in `sumLineItems`
  fix: integer cents + test; gate in CI  ·  src/payments/totals.ts:31
  Key: src/payments/totals.ts:sumLineItems:verification-loop:float-money
  why: `10.10+20.20+30.30 !== 60.6`, no test — billing drift.
  basis: checked — the failing case becomes the test; no API change.

### Cut findings
[P1][trade][G-002][executable-spec][enforcement] "money integers" rule unenforced — Key: CLAUDE.md:money-rule:executable-spec:prose-only
P2/P3: none in examined dimensions (pattern-hygiene not swept — see its UNKNOWN row).

### Suggested sequence
G-001 first (high-risk), then the cut P1.

### First safe improvement
Run `/guardian improve G-001` — smallest change with the highest risk reduction.

### Do-not-touch without approval
The Stripe webhook signature check (high-risk class).
```
