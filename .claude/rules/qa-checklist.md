# Live QA Rule

Unit tests prove the code does what the code says. They cannot prove the
**product does what the docs promise** — that gap is closed by live QA passes
against a running server.

This repo used to track those passes as issues indexed by a single umbrella
tracker ([#748](https://github.com/ttoss/soat/issues/748), now closed). That
tracking approach is **retired**. A live QA pass is still valuable
verification and the procedure below still applies, but it is no longer a
mandated, centrally-indexed process — do not reintroduce a per-module
checklist file, and do not open a new umbrella tracker issue to replace #748.

This rule is separate from `quality-assurance.md` (which governs the automated
Definition of Done) and from `tests.md` (which governs where unit tests live).

## When to act

- **A live pass finds a real deviation from documented behavior** — fix it, or
  if it can't be fixed in the same session, file a normal issue labeled `qa`
  describing the deviation. Close that issue when the defect is fixed, same as
  any other bug.
- **A live pass confirms documented behavior works** — nothing to file.
- **A behavior turns out unreachable on this infrastructure, or is an unbuilt
  feature** — this is not a defect; do not file an issue for it. Mention it in
  the session/PR summary if it's relevant context, but there is no standing
  inventory to update.

## Running a pass

1. Read `packages/website/docs/modules/<module>.md`. **Every claim it makes is a
   test.** A promise with no test is the gap.
2. Prefer the `soat` CLI, so the pass exercises the path a customer uses. Drop to
   REST or MCP JSON-RPC only where there is no CLI equivalent — a missing CLI
   command is itself a defect.
3. **Never block a shared tenant.** Scope enforcement tests (quotas, guardrails)
   to a disposable victim: a throwaway project, a victim API key, or a guardrail
   expression keyed to a single agent id. A project-wide quota or guardrail on a
   shared instance blocks other people's traffic.
4. **Assert structure, never LLM output.** Status codes, `decision` values, entry
   counts, `source_type` — never generated text. Where a model's prose is the
   only visible signal, go find the underlying record; the prose is a summary of
   the behavior, not evidence of it.
5. **Use a positive control.** A `403` proves nothing unless the same principal
   gets a `200` on an action it does hold. A fail-closed result proves nothing
   unless the permissive branch was genuinely reachable.
6. **Drive it; do not read it.** Every defect found on 2026-07-27 (#745, #746,
   #747) sat behind an item that had been skipped for want of a fixture, and two
   were previously recorded as "verified by source review". Source review is not
   a pass.
7. Clean up fixtures, and record what could not be removed. Agents and projects
   that accrue generations or audit entries hit `AGENT_HAS_DEPENDENTS` /
   `PROJECT_HAS_DEPENDENTS` and cannot be deleted.
