# Guardian — Baseline & reconciliation

## Phase 0 — Baseline discovery

Establish what the repo already enforces, so Guardian finds declared-but-unenforced rules and never re-flags what's enforced.

**The change under review** = the tracked diff **plus every untracked (`??`) file** in `git status --short`; read each new file in full — `git diff HEAD` never shows them. If the working tree is clean, review the branch instead: `git diff origin/main...HEAD` (or the repo's default base) — state which diff was reviewed.

A **focused check** is the cheapest command that can fail because of the changed files — a package- or file-level test/lint/typecheck (e.g. `pnpm test --filter <pkg>`), never the full suite unless the change crosses a package, API, or security boundary. It is the one package script Light discovery may run. If no focused check exists for the changed files, state `focused check: none` in the mode's verification output, raise it as a finding (`verification-loop`, rung `enforcement` — usually the first safe improvement), and proceed; never substitute a suite over ~5 minutes.

**Light** (default for `review`): `git status --short`, `git diff --stat HEAD`, `git diff HEAD`; the changed files (incl. untracked); the nearest relevant `CLAUDE.md`/`.claude/rules`/`AGENTS.md`/`*.spec.md`; package scripts and the focused check for the changed files.

**Deep** (`audit`, a full `docs review` (no surface), or when the diff touches config, CI, lint, test, coverage, hooks, package/layer boundaries, a high-risk domain, or an instruction surface): resolve the **effective lint config incl. extended/shared configs** (a local config often just extends a package; reading it alone misses inherited rules/plugins); type strictness; test & coverage config (is coverage collected, thresholds set, gated?); CI gates (what actually runs on PR/merge); pre-commit/commit hooks; the **instruction surfaces across tools**: `CLAUDE.md` root+nested, `.claude/rules/**`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/**`, `.cursorrules`, `.windsurfrules`, `.devin/rules/**`, and agent skill files (`**/SKILL.md` plus the files it references, `.claude/skills/**`).

Sweep rules for instruction surfaces: (1) read root/always-on surfaces in full, plus surfaces on the path to and beneath the run's scope (the audited path, or the changed files); only a full `docs review` (no surface) sweeps everything. (2) If in-scope surfaces exceed ~15, inventory them all (path + line count), read root/always-on in full, and propose sub-scope batches for the rest.

**Output**: disposition **every** item above as `enforced` / `prose-only` / `absent`, and where enforcement runs (local hook / CI / both). An omitted item reads as unchecked, which is not allowed; discovery is complete when every listed item is dispositioned.

**Discovery safety**: read-only by default — file reads and the toolchain's own print-config/inspection commands. Never run install, build, deploy, migration, postinstall, or arbitrary package scripts. If resolving config would execute project code with side effects, propose the command and ask first.

## Reconciliation — declared vs. enforced

For each stated quality rule, check enforcement:

- stated + enforced → fine; don't re-flag.
- stated + unenforced + mechanizable → finding: codify it.
- stated + unenforced + questionable rule → finding: fix the rule (rewrite/remove); never codify badness.
- enforced + unstated → fine; document only if surprising.
- code diverges from a stated rule → **evidence, not a verdict**. Default hypothesis: the divergence marks an **undeclared invariant** — intentional behavior the rule never captured; "fixing" it is the costliest agent failure. Discharge the hypothesis with observable evidence (tests, git history, callers/usage — or ask) before attributing fault; then judge each side on the evidence (both may be findings): code wrong → code-level finding · rule stale → rule-level finding (rewrite/remove) · both right, axis undeclared → finding: declare the invariant at the smallest correct surface (stewardship table, `reference/methodology.md`).
- an instruction surface declares an invariant a hard rule (e.g. "hard rule", "critical", "never", "must always hold") → any change altering that invariant's guarded contract joins the **high-risk class** for this run (`SKILL.md`), even if the domain isn't among the class's listed examples — the repo's own declared priority is evidence, and the class is defined by its axis, not by the example list.

Also detect contradictions between surfaces and hand-maintained duplication/drift across tools.
