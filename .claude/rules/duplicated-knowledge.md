# Duplicated Knowledge

A rule in N places is enforced N ways; the copies drift, and defects cluster
where one question is answered more than once.

**Consolidate it whenever you find it**, in the current change or a task of
its own. Whether to consolidate is not an open choice (`open-questions.md`);
only a behavior change it implies may be (item 4 below).

## Recognising it

| Signal | Shape |
| --- | --- |
| One question answered per site | each row carrying a field decides for itself whether it is validated, stripped, cleared, echoed |
| A fix that applies to siblings | the defect fixed here also sits in sibling call sites doing the same job |
| A second transcription | a field list, status set or allowlist written out twice |
| Shotgun surgery | adding one more sibling means editing N files the same way |

- The test: **would a new sibling have to re-derive the answers?** If yes, the
  knowledge has no home.
- Copy count is not the test: two copies of a security rule qualify, ten
  copies of a one-line mapper do not.

## Not every repetition

- Consolidate only copies that **change together** (one reason to change, not
  one shape today); coincidental lookalikes stay apart.
- Knowledge a module legitimately owns stays in the module; `modules.md`
  §Shared business rules draws the same line for transport-independent rules.

## What a proposal states

1. **The divergence table** — a row per site, a column per question, what each
   answers today. The table is the argument.
2. **The chokepoint** — where the answer lives and what each site becomes
   (e.g. `lib/toolContextCarrier.ts`, the ingress every carrier of a stored
   `tool_context` writes through).
3. **What the shared form forces** — a required argument, not a defaulted one,
   so a new site states its answer.
4. **Every behavior change it implies** — name each site that was wrong; run
   the ones touching security, a public contract or data loss through
   `open-questions.md`.
5. **The enforcement that keeps it consolidated** — a test that fails when a new
   site bypasses the chokepoint: structure in `tests/harness/`, behavior at the
   entry point (`tests.md`). It outranks prose (the long-term test,
   `open-questions.md`); a consolidation with no test reopens.

## Landing it

- Red first, on exactly the sites that are wrong, for the right reason
  (`quality-assurance.md`).
- Expect defects in divergent copies; root-cause each, never adopt the
  majority's answer.
- Re-read the diff where the shared shape reads differently from the copy it
  replaces: absent, empty and inherited-default values are three different
  things one normalization collapses.
