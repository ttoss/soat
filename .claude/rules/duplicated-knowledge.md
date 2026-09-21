# Duplicated Knowledge

A rule that lives in N places is enforced N ways. The copies drift, and the
drift is only visible on the request that exploits it — which is why defects
cluster wherever one question is answered more than once.

**Propose consolidating it whenever you find it**, in the change you are already
making. Landing it is a separate decision: put the proposal up first, unless the
consolidation sits inside the change you were asked for and alters no behavior.

## Recognising it

| Signal | Shape |
| --- | --- |
| One question answered per site | each row carrying a field decides for itself whether it is validated, stripped, cleared, echoed |
| A fix that applies to siblings | the defect being fixed here also sits in the four call sites doing the same job |
| A second transcription | a field list, status set or allowlist written out twice |
| Shotgun surgery | adding one more sibling means editing N files the same way |

The test is **would a new sibling have to re-derive the answers?** If yes, the
knowledge has no home. Copy count is not the test: two copies of a security rule
qualify, ten copies of a one-line mapper do not.

## Not every repetition

Copies that merely look alike are cheaper apart. Establish that they **change
together** — one reason to change, not one shape today. Consolidating
coincidental similarity buys a wrong abstraction plus a dependency between
things that have nothing to do with each other.

Knowledge a module legitimately owns stays in the module; `modules.md`
§Shared business rules draws the same line for transport-independent rules.

## What a proposal states

1. **The divergence table** — a row per site, a column per question, what each
   answers today. The table is the argument; "these are duplicated" is not.
2. **The chokepoint** — where the answer lives and what each site becomes
   (`lib/toolContextCarrier.ts` is one: the ingress every carrier of a stored
   `tool_context` writes through).
3. **What the shared form forces** — a required argument beats a defaulted one,
   so a new site states its answer instead of inheriting one silently.
4. **Every behavior change it implies** — the sites that were wrong now change.
   Name each, and forward the ones touching security, a public contract or data
   loss (`open-questions.md`).
5. **The enforcement that keeps it consolidated** — a test that fails when a new
   site bypasses the chokepoint: structure in `tests/harness/`, behavior at the
   entry point (`tests.md`). Deterministic enforcement outranks prose
   (`open-questions.md` Test 2), and a consolidation with no test reopens.

## Landing it

- Red first, and red on exactly the sites that are wrong, for the right reason
  (`quality-assurance.md`).
- Expect defects: divergent copies are where the bugs already sit. Root-cause
  each one rather than adopting whatever the majority does.
- Re-read the diff for sites where the shared shape reads differently from the
  copy it replaces. An absent value, an empty one and an inherited default are
  three different things, and one normalization collapses them.
