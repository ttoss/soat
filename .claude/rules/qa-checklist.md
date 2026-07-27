# Live QA Rule

Unit tests prove the code does what the code says. They cannot prove the
**product does what the docs promise** — that gap is closed by live QA passes
against a running server.

Those passes are tracked as **issues**, indexed by the tracker
[#748](https://github.com/ttoss/soat/issues/748). There is no per-module
checklist file, and one must not be reintroduced.

This rule is separate from `quality-assurance.md` (which governs the automated
Definition of Done) and from `tests.md` (which governs where unit tests live).

## Why issues, not files

A checklist file records "verified on date X" and then keeps asserting it. The
code moves, the file does not, and nothing forces a re-run — so it degrades from
a coverage map into a claim nobody has standing to trust. The failure is silent:
a stale `[x]` is indistinguishable from a fresh one.

An issue cannot go stale that way. It is open or it is closed, and closing it
takes a deliberate act by someone who looked.

The cost is real and worth naming: deleting the checklists gave up the
**enumeration** of what should be verified per module. #748 carries that
inventory forward — the unverified surface, why each item is unreachable, and the
procedure for a pass. Keep it current, because it is now the only such record.

## When to act

| Change | Action |
|---|---|
| A live pass finds a deviation | File an issue labeled `qa`, link it in #748 |
| A live pass confirms a documented behavior works | Nothing to file. Note it in #748 only if it closes a gap that issue lists |
| A defect is fixed | Close its issue; #748's index reflects it |
| A behavior turns out unreachable on this infrastructure | Record it under "Not verifiable here" in #748 with the reason — never as an issue |
| A new module ships | Add it to the never-passed list in #748 |

**Do not file an issue for a coverage gap.** An issue closes; a gap does not. An
unbuilt feature, an environment limit, or a behavior nobody has attempted belongs
in #748's inventory, not in a bug report.

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
