# QA Checklist Rule

Unit tests prove the code does what the code says. They cannot prove the
**product does what the docs promise** — that gap is closed by live QA passes,
recorded as per-module coverage checklists in [`docs/qa/`](../../docs/qa/README.md).

This rule says when those checklists must be touched. It is separate from
`quality-assurance.md` (which governs the automated Definition of Done) and from
`tests.md` (which governs where unit tests live).

## When a checklist must be updated

| Change | Checklist action |
|---|---|
| New module (new `openapi/v1/<module>.yaml`) | Create `docs/qa/<module>.md`, **or** add the module to the "Pending a first pass" list in `docs/qa/README.md` |
| New documented behavior on an existing module | Add the corresponding checklist item, unchecked, with a reason annotation |
| A behavior's contract changes (status code, field, error code) | Update the affected item so it describes the new contract |
| A defect found by a live pass | File an issue labeled `qa`, and leave the item unchecked linking that issue |
| A defect fixed | Tick the item and reference the issue it was (`was #NNN`) |
| A live pass run | Add a Run history row, tick what was verified, refresh the coverage count in `docs/qa/README.md` |

Nothing enforces any of this automatically. There is no test asserting a module
has a checklist, that its items still match the docs, or that unchecked boxes
carry a reason — all of it rests on the change author and on review. That makes
the table above the whole mechanism, so treat it as binding rather than advisory.

The two failure modes to watch for, since no test will catch them:

- A new module ships with neither a checklist nor a pending-list entry, so its
  unverified state is invisible rather than tracked.
- An unchecked box is left bare. `[ ]` with no annotation is indistinguishable
  from an item someone forgot to tick, which silently converts a known gap into
  apparent coverage.

## Checkbox semantics

- `[x]` — verified against a live server in at least one pass.
- `[ ]` — not verified. Every unchecked box carries either an inline reason
  (`— *not exercised, needs a context tool*`) or a linked issue.

Never tick a box because a unit test covers the behavior. The whole point of the
checklist is that it records observed product behavior, not test coverage. If a
behavior is only provable by unit test (an internal seam, a 24h expiry sweeper),
say so in the annotation and leave it unchecked.

## Where the artifacts go

Three homes, three lifetimes — do not collapse them:

- **The checklist** → `docs/qa/<module>.md`. Lives as long as the module.
- **A run report** (what one pass observed, in which environment, with what
  fixtures and cleanup) → a `QA` **discussion** on `ttoss/soat`, linked from the
  Run history table. Never an issue: a run report has nothing to close.
- **A defect** → an **issue** labeled `qa`, referencing the checklist item.

## Running a pass

The full procedure is in [`docs/qa/README.md`](../../docs/qa/README.md). The parts
that are easy to get wrong:

- **Prefer the CLI.** A pass driven through `soat` exercises the path a customer
  uses. Drop to raw REST or MCP JSON-RPC only where there is no CLI equivalent —
  and if a documented CLI command is missing, that is itself a defect to file.
- **Never let a pass block a shared tenant.** When testing enforcement (quotas,
  guardrails), scope it with a disposable "victim" principal rather than a
  project-wide cap. The 2026-07-26 quotas pass lost one check to exactly this.
- **Assert structure, never LLM output.** Status codes, `action` values, entry
  counts, `source_type` — never generated text.
- **Record what you could not reach.** "Needs a multi-replica deployment" is a
  legitimate outcome and must be visible in the Not covered section. An item
  that silently disappears reads as covered.
- **Clean up fixtures**, and note anything that could not be deleted and why.
