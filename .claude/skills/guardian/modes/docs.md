# Mode: docs

Review/improve the repo's context/instruction surfaces. A **surface = one file** (for a JSDoc/TSDoc target, one file's doc blocks). Submodes: `review` (diagnose — with a surface, that one file; without one, the **full review**: every instruction surface, the instruction-surface projection of `audit`, always Deep baseline), `improve` (edit one approved surface — a JSDoc/TSDoc target is just a surface whose doc blocks are the content; Core rule 7 applies). The Action axis (`SKILL.md`) governs which submodes write.

Steps: inspect the surfaces in scope; run the instruction-artifact syndromes on each (`reference/methodology.md`); identify the ambiguity/failure mode the doc should reduce; choose the smallest correct surface (stewardship table in `reference/methodology.md`); ensure surfaces are themselves written in basis-form and, where a basis-form rule belongs in a durable surface and is missing, write it there (propagate — `reference/basis-form.md`); prefer enforceable structure over prose; remove/propose removal of stale/duplicated text (stale criteria in methodology); verify any asserted behavior or recommend a test.

Required/Optional changes entries use the SKILL finding format and **Output discipline** (SKILL) — instruction findings anchor as `path:heading:dimension:rule`.

Verdicts: a single-surface `review` and `improve` use the four ranked verdicts from `SKILL.md`. The full review always emits `DOCS_BACKLOG` — the instruction-surface mirror of `audit`'s `AUDIT_BACKLOG`: the verdict names the run's shape (an inventory, not a gate on one unit), not its severity; every P0 still surfaces in full under Required changes.

For the full review, prepend `### Surfaces found / reviewed`: one line per surface from the Deep baseline list — disposition `reviewed | absent`, and for reviewed surfaces the enforced/prose-only status. A discovered surface missing from this section means unchecked — a defect in the run, not an allowed omission.

```md
### Documentation verdict PASS | PASS_WITH_FIXES | PASS_WITH_ACCEPTED_RISK | BLOCK (single surface / `improve`) | DOCS_BACKLOG (full review)

### Surfaces found / reviewed (full review only)

### Context cost LOW | MEDIUM | HIGH

### Ambiguity reduced

### Recommended surface enforcement | nested CLAUDE.md | .claude/rules | root CLAUDE.md | skill | \*.spec.md | JSDoc/TSDoc | AGENTS.md

### Required changes [P0/P1][dominant|trade][G-###][dimension][rung] title + detail tier (SKILL finding format; P0 first, then P1) ...

### Optional changes [P2/P3][dominant|trade][G-###][dimension][rung] title — one line each ...

### Patch or proposal

### Verification needed
```

## Example

`docs review` of a bloated root `CLAUDE.md`.

```md
### Documentation verdict PASS_WITH_FIXES

### Context cost HIGH

### Ambiguity reduced
CLAUDE.md is 420 lines; most is a per-directory list — a case-enumeration where a path-scoped rule belongs.

### Recommended surface .claude/rules
Move the `src/api/**` conventions to `.claude/rules/api.md` with a `paths:` glob (loads on demand).

### Required changes
[P1][dominant][G-001][instruction-hygiene][path-scoped-context] Per-directory case-list bloats the always-loaded surface
  fix: extract the API section to `.claude/rules/api.md` (`paths:` glob); delete the 3 stale commands; leave a one-line pointer  ·  CLAUDE.md:12
  Key: CLAUDE.md:api-conventions:instruction-hygiene:global-case-list
  why: lines list conventions per directory, and 3 named commands are absent from package.json (stale) — context cost every session, stale commands mislead agents.
  basis: checked — content moves verbatim; the 3 commands verified absent from package.json.

### Optional changes
[P2][trade][G-002][instruction-hygiene][path-scoped-context] Test conventions could move to a nested CLAUDE.md under `src/` — Key: CLAUDE.md:test-conventions:instruction-hygiene:global-case-list

### Patch or proposal
(proposal — `docs review` is read-only; run `/guardian docs improve CLAUDE.md` to apply)

### Verification needed
Confirm the moved rules still load when editing an `src/api` file.
```
