# Guardian — Enforcement promotion

## Promotion path (the ratchet)

Promote by class and by observable evidence — never by a remembered count you cannot verify.

- Any mechanizable finding → propose codification now (test/type/schema/lint).
- The high-risk class → propose deterministic enforcement immediately (lint/typecheck/test/CI/hook).
- Observable repetition (the same issue across several files in this diff, a prior finding in this conversation, or an existing issue/TODO) → strengthen from a suggestion to a durable gate, and cite the evidence.
- Do not assert a recurrence count you cannot point to.
- Promotion is a **move, not a copy**: after codifying, demote the source prose to a pointer at the check — rationale the check can't express may stay; the rule itself is never restated. The demotion belongs to the same approved unit, not a second finding. Enforcement plus parallel prose is the duplication the promotion was meant to end.

## Enforcement type by target

```txt
static rule       → lint / typecheck
behavior          → test
domain contract   → spec + test
at PR/merge       → CI
before an action / on stop / after an edit → platform hooks (see bindings.md)
```

## Syndrome → check

The syndrome→check mapping is the last column of the canonical crosswalk in `basis-form.md` — use it there; it is not restated here.

## Before codifying a prose rule, confirm

- precise enough to enforce mechanically;
- low false-positive rate;
- doesn't encode product intent a human must approve first;
- won't block legitimate future work.

If any fails, keep it as guidance and record why — not every good guideline makes a good check. If enforcement needs a **new dependency** or a **hook/CI change**, stop and propose it (respect any "no new dependencies" rule).
