# Guardian — Methodology reference

## AI Repo dimensions

These 8 dimensions are the single operational lens: every finding carries exactly one of these slugs (the 4 basis-form tests are never a finding tag). Each dimension's parent test and promotion check live in the canonical crosswalk in `basis-form.md`; the bad-lists below are the operational detail. Relevance rule: a dimension is relevant iff the diff/scope touches an artifact it governs; when unsure, check it. Trace an emission or write to its **sink**, not its call-site's apparent domain — a metrics/log call that also writes to an audit/evidence/provenance record, ledger, or other high-risk-class sink is governed by that sink's dimensions and class membership, not by the call site's surface label (e.g. "telemetry"). Skipping is a decision, never silent — `audit` records skipped dimensions as `UNKNOWN` rows; `review` records them under Coverage. Never flag what the baseline shows already enforced.

**Axis-cited classification.** A dimension tag is valid only when it cites which crosswalk test (`basis-form.md`) the finding's evidence actually maps to — never when it is chosen by pattern-matching the call site's surface vocabulary (a variable, function, or event name). If a finding can't name its test, it isn't classified yet — re-trace it to its sink or contract before tagging. Before finalizing severity/dimension, run the swap-test: would this classification survive if the surface label were replaced by a neutral placeholder, holding the underlying contract fixed? If the answer changes when the label does, the surface was classified, not the essence. The swap-test is never rendered as its own paragraph — a "root cause:" section that doesn't change any tag is decoration, not diagnosis. Its only legitimate trace is a severity or dimension that comes out differently than naive pattern-matching would have produced; judge this discipline the way Guardian judges itself — not by how often the test is mentioned, but by how often it changes a call.

1. **Context compressibility** (`compressibility`) — can the change be explained through a small, bounded context packet? Bad: small behavior needs whole-system understanding; logic spread across layers; new cross-cutting knowledge with no contract; a large file becoming a gravity well.
2. **Executable specification** (`executable-spec`) — is important intent in tests, types, schemas, validators, or specs (not just conversation)? Bad: new behavior without acceptance tests; business rule hidden in a conditional; requirement only in an issue comment; spec duplicating code-readable facts instead of intent/boundaries/non-goals.
3. **Co-located specs** (`co-located-spec`) — when code can't express intent, use `*.spec.md` beside the artifact. Good: intent, constraints, acceptance criteria, boundaries, non-goals, risk class, verification commands. Bad: rewritten source, duplicated type shapes, generic prose, untested assertions.
4. **Verification loop** (`verification-loop`) — two axes, both required: **cost** (can a future agent run a focused check quickly?) and **oracle fidelity** (can the check actually fail when the contract breaks?). Bad, cost: only manual testing proves it; only slow e2e covers local behavior; command not discoverable; PR claims success without evidence. Bad, fidelity: snapshots updated without reviewing the diff; asserting status/shape where the contract is the payload; behavior at a deployed boundary (live schema, persisted data) covered only by mocks.
5. **Boundary integrity** (`boundary-integrity`) — are package/layer/domain/ownership/public-API boundaries preserved **and enforced**? Check both: does the change violate a boundary, and does the boundary exist only in prose (candidate for import-restriction lint / dependency-graph check)?
6. **Pattern hygiene** (`pattern-hygiene`) — did the change copy or strengthen a bad local pattern (more nesting in a complex fn, more special cases in a god file, a workaround becoming the norm, "file style" that is actually debt)? Agents replicate whatever they see.
7. **Debt containment** (`debt-containment`) — accept debt only if modular, visible, observable, cheap to repay. Unacceptable: invisible, systemic, untested, in core logic, or likely to be copied.
8. **Instruction & context hygiene** (`instruction-hygiene`) — review the instruction surfaces in scope (from the baseline) with the syndromes below. Also bad: CLAUDE.md grown into a manual (target <200 lines); generic advice; local rule placed globally; procedure that belongs in a skill; the same rule hand-duplicated across tools, or — when in-repo evidence shows it — across the org's repos (drift; the same irreducible violation one level up: flag a shared-surface candidate, don't create it). Loading/precedence mechanics live in `bindings.md`.

## Instruction-artifact syndromes

Apply to every instruction surface in scope — CLAUDE.md/rules/AGENTS.md-class files **and agent skill files**. Mechanical, one pass per surface; every hit cites file + quoted line:

1. **Undefined term** — every term used operationally in ≥2 places has exactly one definition site.
2. **Claim diff** — a fact stated in more than one file must agree in substance everywhere; diff the statements.
3. **Quantifier audit** — for every `always/never/only/all/once/"X does Y"` claim, verify it holds against each mode/scope/constraint it spans (the JSDoc never/always rule below, applied to instructions).
4. **Classification totality** — push boundary cases through every rule table (severity, routing, verdicts): exactly one bucket may fire; two or zero → finding.
5. **Template drift** — every output template and worked example must carry every mandatory field of the format it instantiates; prose and template must agree on cardinality.
6. **As-rendered** — evaluate the file as the runtime renders it: substitute placeholders (e.g. `$ARGUMENTS`) literally, under empty / one / many tokens (mechanics in `bindings.md`).

## Self-review

If any reviewed surface was authored or edited in this session:

1. Fluency and memory of writing are zero evidence — re-read the file from disk; support every conclusion about it with a verbatim quote + path.
2. Never score such a surface GOOD/PASS without at least one cited mechanical check (a syndrome pass, claim diff, or command run).
3. State the self-review condition in the output; prefer a fresh-context pass (subagent) for instruction surfaces authored in-session.

## Documentation stewardship

Choose the smallest correct surface, preferring higher ladder rungs:

```txt
machine-enforceable rule        -> test, type, schema, lint/check, CI, hook   (prefer)
directory/layer-scoped guidance -> nested CLAUDE.md (co-located, on demand)
file-type/cross-cutting rule    -> .claude/rules/*.md with `paths:` glob
always-relevant global rule     -> root CLAUDE.md (<200 lines)
repeatable procedure            -> a skill
domain/product intent           -> co-located *.spec.md
public API contract             -> JSDoc/TSDoc
cross-tool portability          -> AGENTS.md as source, imported/symlinked by CLAUDE.md
```

Add docs only when they cut future ambiguity more than they add context cost. A doc is **stale** when it: names commands that don't exist; contradicts package scripts or CI; describes removed APIs; repeats type shapes that changed; conflicts with a closer-scoped instruction; or asserts behavior not covered by tests or current code.

## JSDoc/TSDoc policy

Document invariants, side effects, fail-open/closed behavior, security/permission/billing/data semantics, deprecations, misuse-preventing examples, and behavior types can't express. Don't mandate exhaustive JSDoc on trivial exports (context cost + duplicates the signature); a repo rule that does is a flaggable quality claim. Don't assert guarantees stronger than the code enforces: if a comment says "never/always/must/throws/pure/idempotent/fail-closed/safe", verify code/tests enforce it — else soften the wording or raise a finding.
