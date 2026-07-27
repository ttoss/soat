# QA Coverage Checklists

Per-module maps of **which documented behaviors have been verified against a live
server**. These are not unit tests. They record what a human or agent actually
observed on a running SOAT instance, exercising the module through its real
surfaces (CLI, REST, MCP) the way a customer would.

Unit tests prove the code does what the code says. These checklists prove the
**product does what the docs promise** — the gap that `pnpm test` structurally
cannot close.

## Why these live in the repo

A checklist is a spec of the module's observable contract, so it has the same
lifetime as the module and must change in the same commit the module does. That
rules out the wiki (unversioned, invisible to a repo clone, no review) and the
issue tracker (issues close; a coverage map never does).

The split is:

| Artifact                                                       | Lifetime              | Home                                                     |
| -------------------------------------------------------------- | --------------------- | -------------------------------------------------------- |
| **The checklist** — what must be verified                      | As long as the module | **This directory**                                       |
| **A run report** — what one pass observed, in what environment | Point-in-time         | A `QA` **discussion**, linked from the Run history table |
| **A defect found** — reproducible bug                          | Until fixed           | An **issue**, labeled `qa`                               |

## Checkbox semantics

- `[x]` — verified working against a live server in at least one pass. The Run
  history table says which.
- `[ ]` — **not** verified. Either never exercised, or a live defect. Every
  unchecked box carries an inline annotation saying which, and a linked issue
  when it is a defect.

An unchecked box is never left unexplained. "We didn't check this" and "this is
broken" are both useful, but they must be distinguishable at a glance.

## File layout

One file per module, named after its OpenAPI spec
(`packages/server/src/rest/openapi/v1/<module>.yaml`) so the mapping is
mechanical: `quotas.yaml` → `docs/qa/quotas.md`.

Each file has:

1. **Header** — coverage count, last pass, link to the module docs.
2. **Run history** — one row per pass: date, surface, result, defects filed.
3. **Checklist sections** — grouped by concern. Every module covers at minimum:
   CRUD & response contract, validation, auth & permissions, and (where the
   module has one) its formation resource.
4. **Not covered** — items deliberately out of reach, each with the reason.
   Environment limits ("needs a multi-replica deployment") are not failures, but
   they must be visible rather than silently absent.

## Running a pass

1. Read `packages/website/docs/modules/<module>.md`. **Every claim it makes is a
   checklist item.** If the docs promise a behavior that has no box, add the box.
2. Work through the checklist against a live server, preferring the `soat` CLI
   (`$SOAT_CLI`) so the pass exercises the same path a customer uses. Fall back
   to raw REST or MCP JSON-RPC only where there is no CLI equivalent.
3. Use a dedicated project where possible. When testing enforcement that can
   block traffic (quotas, guardrails), scope it so no shared tenant is affected —
   a disposable "victim" API key rather than a project-wide cap.
4. File every deviation as its own issue, labeled `qa`, referencing the checklist
   item. Do not fix-and-move-on silently.
5. Update this file: tick the boxes, add a Run history row, refresh the coverage
   count.
6. Clean up fixtures. Note anything that could not be removed and why.

## Adding a module

A new module either gets a checklist here or an entry in the pending list below.
Nothing enforces this automatically — it is a review-time obligation, wired into
the module checklist in `.claude/rules/modules.md`.

## Index

Coverage is `verified / total items`. The shortfall is always itemized in that
file's **Not covered** section — it is a gap list, not a failure count.

| Module                                | Coverage | Last pass  | Source                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [audit-log](./audit-log.md)           | 42/45    | 2026-07-27 | [#707](https://github.com/ttoss/soat/issues/707), [#745](https://github.com/ttoss/soat/issues/745)                                                                                                                                                       |
| [guardrails](./guardrails.md)         | 31/35    | 2026-07-27 | [#633](https://github.com/ttoss/soat/issues/633)                                                                                                                                                                                                         |
| [knowledge](./knowledge.md)           | 15/17    | 2026-07-27 | [#348](https://github.com/ttoss/soat/issues/348)                                                                                                                                                                                                         |
| [memories](./memories.md)             | 22/27    | 2026-07-27 | [#348](https://github.com/ttoss/soat/issues/348)                                                                                                                                                                                                         |
| [orchestrations](./orchestrations.md) | 125/135  | 2026-07-27 | [#721](https://github.com/ttoss/soat/issues/721), [#722](https://github.com/ttoss/soat/issues/722), [#723](https://github.com/ttoss/soat/issues/723), [#724](https://github.com/ttoss/soat/issues/724), [#746](https://github.com/ttoss/soat/issues/746), [#747](https://github.com/ttoss/soat/issues/747) |
| [quotas](./quotas.md)                 | 102/108  | 2026-07-27 | [#705](https://github.com/ttoss/soat/issues/705), [#713](https://github.com/ttoss/soat/issues/713), [#742](https://github.com/ttoss/soat/issues/742), [#743](https://github.com/ttoss/soat/issues/743)                                                  |
| [tasks](./tasks.md)                   | 20/20    | 2026-07-18 | [#595](https://github.com/ttoss/soat/issues/595)                                                                                                                                                                                                         |
| [workflows](./workflows.md)           | 72/74    | 2026-07-19 | [#594](https://github.com/ttoss/soat/issues/594), [#596](https://github.com/ttoss/soat/issues/596), [#597](https://github.com/ttoss/soat/issues/597), [#616](https://github.com/ttoss/soat/issues/616), [#617](https://github.com/ttoss/soat/issues/617) |

The 2026-07-27 pass worked the unchecked boxes across every existing checklist
rather than opening a new module. What it changed:

- **Everything reachable without a live generation is now closed.** A purpose-built
  limited principal — a user carrying a deliberately narrow policy — unlocked the
  `401`/`403` items that three earlier passes had to skip because they drove the
  MCP interface with a single fixed credential (knowledge, memories,
  `orchestrations:GetQueueStats`, guardrail detach isolation).
- **Three unreached items turned out to be defects.** Boxes left unchecked for
  want of a fixture are not neutral — they hide real behavior. The audit-log
  global-entries box was blocked only by credential scope; re-run with an admin
  token it showed identity and authorization mutations are never audited at all
  ([#745](https://github.com/ttoss/soat/issues/745)). Building a deliberate `4xx`
  target showed a terminal upstream error consumes the entire retry budget
  ([#746](https://github.com/ttoss/soat/issues/746)). Driving an agent node's
  `output_schema` for real showed it silently fails on markdown-fenced JSON —
  the default way an LLM emits it ([#747](https://github.com/ttoss/soat/issues/747)).
- **A second disposable project unlocked the contention tests.** `max_concurrent_runs`
  and `per_project` scoping both need contended, differently-owned queue state.
  Per this file's own rule, the cap went on a throwaway project rather than the
  shared tenant.
- **Nine "unimplemented at the time of the pass" items were re-confirmed**, not
  re-investigated — they remain unbuilt features rather than defects.

What is left is now sharply characterized. The largest remaining gap is still
**stricter-wins composition across scopes** (guardrails): `/evaluate` cannot
reach it, because it evaluates one guardrail while composition is by definition
the interaction of several. It stays the only unverified behavior that could
silently _loosen_ enforcement if wrong, and it needs an agent that actually
emits a tool call. The rest of the backlog is environment-bound (multi-replica
atomicity, a load harness, real time passing) rather than merely unattempted.

## Pending a first pass

**8 of 34 modules have had a live pass.** These 26 have not. This list is the
backlog — remove an entry when its checklist lands, and add one whenever a new
module ships without a pass.

`actors` · `agents` · `ai-providers` · `api-keys` · `approvals` · `chats` ·
`conversations` · `discussions` · `documents` · `embeddings` · `exceptions` ·
`files` · `formations` · `generations` · `ingestion-rules` · `memoryEntries` ·
`policies` · `projects` · `secrets` · `sessions` · `tools` · `traces` ·
`triggers` · `usage` · `users` · `webhooks`
