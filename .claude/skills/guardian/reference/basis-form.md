# Guardian — basis-form (the standard)

basis-form is Guardian's definition of quality. It governs **structure, code, scripts, and instructions** alike: describe the decision space by its **basis** (the axes), never by its **cases** (the points). A finite basis generates every case, including ones never written; a case-list only covers what was enumerated.

Its projections are the 8 dimensions (`methodology.md`) and its consequences are the 4 AI Repo properties; the **canonical crosswalk** below is the single source for how tests, dimensions, and checks map — `methodology.md` and `enforcement.md` reference it, never restate it.

## The four tests

- **Irreducible** — remove it and the span shrinks; no combination of the others recovers it. Violation: duplication / more than one source of truth. Fix: derive the rest from one.
- **Orthogonal** — statements/modules share no content; changing one doesn't change what the other covers. Violation: a concern spread across places (change amplification). Fix: one owner; enforce with an import/dependency boundary.
- **Spanning** — every case in the space has a defined decision. Violation: partial function, unhandled case, missing validation. Fix: total functions, exhaustive match, schema at the edge.
- **Decodable** — the reader (human or model) expands the axis into cases from their own priors. Violation: clever / over-compressed. Fix: idiomatic to the codebase's conventions.

## Two directions of failure (both violate basis-form)

- **Case-enumeration** (under-abstraction): a point-list where an axis exists — a `switch`/`if` per case, copy-paste, hardcoded variants. Migrate case→basis **only when the axis is already visible** (≈3 concrete points) and the migration reduces blast radius or ambiguity.
- **Empty axis** (over-abstraction): a basis vector added before its span exists — a generic wrapper/framework/config with no concrete consumer. It spans a space with no points. Collapse it back to cases until the axis reappears.

Never create an axis speculatively; never leave a visible axis as cases. This guardrail is intrinsic to basis-form, not borrowed from any repo.

## Canonical crosswalk (single source of truth)

Every finding is tagged with exactly one **dimension** (the operational lens; the 8 live in `methodology.md`). Each dimension has exactly one parent **test** (the generative theory above). The 4 **properties** (compressible, contractual, verifiable, safe) are consequences — outcome adjectives for framing, never a finding tag. The 4 tests are theory: used in `plan` (derive axes before points) and to judge a novel case no dimension yet names. This table is the one home; `methodology.md` and `enforcement.md` reference it.

| Test (theory) | Dimensions (finding tags) | Syndrome | Mechanizable check |
|---|---|---|---|
| irreducible | `debt-containment`, `instruction-hygiene` | duplication / more than one source of truth | duplication detector |
| orthogonal | `compressibility`, `boundary-integrity` | concern spread; change amplification; empty axis | import-restriction / dependency-cycle |
| spanning | `executable-spec`, `verification-loop` | partial function / unhandled case | type-exhaustiveness / schema validation |
| decodable | `co-located-spec`, `pattern-hygiene` | clever/over-compressed; copied bad pattern; case-enumeration | complexity + fan-out limit (case-enumeration); otherwise **judgment only** |

Don't over-collapse (these are *not* redundant): `compressibility` sits under orthogonal, but duplication (irreducible's check) also drains it — a dup finding may tag either. `decodable` has no general check — "clever/over-compressed" is judgment; never invent a clever-code lint. `executable-spec` (the contract exists) and `verification-loop` (a check runs fast, is discoverable, and can actually fail) both survive under spanning. The two migration directions stay distinct because their fixes are **opposite**: case-enumeration (under-abstraction → migrate case→basis, tag `pattern-hygiene`) vs empty-axis (over-abstraction → collapse axis→cases, tag `compressibility`).

The essence — are these the domain's true axes? — is judgment; propose it, let the human confirm at the edges. The syndromes are mechanizable: promote each into the repo's own enforcement (`enforcement.md`). The instruction-side parallel of these checks — the instruction-artifact syndromes — lives in `methodology.md`.

Properties are consequences, framing only: compressible ← orthogonal + irreducible; contractual ← spanning captured in types/schemas; verifiable ← spanning + enforcement; safe ← off-axis points quarantined.

## Surfaces (basis-form applies uniformly)

- **structure** — folders are axes, files are points; "where does X go?" and "what do I change for Y?" have one obvious answer.
- **code / scripts** — functions, parameters, and types over branches, duplication, and partial cases.
- **instructions** — the repo's instruction surfaces (per `bindings.md`) must themselves be written in basis-form (axes, not case-lists). Where a basis-form rule belongs in a durable surface and is missing, **propagate it there** (write it), then promote its syndrome to enforcement where one exists.

## How Guardian applies it

basis-form is not a mode you run; it is how every mode judges and acts. `plan` derives the axes before writing points. `review`/`audit` detect drift in both directions. `improve` migrates case→basis or collapses an empty axis, then promotes the syndrome. `docs` keeps instruction surfaces in basis-form and propagates missing rules. Writing follows the Action axis (`SKILL.md`), which overrides this reference: only ACT modes edit/restructure/propagate, one approved unit at a time; DIAGNOSE modes propose. A structural or high-risk change is proposed first, never done silently.
