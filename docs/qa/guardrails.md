# QA checklist — guardrails

Module docs: [`packages/website/docs/modules/guardrails.md`](../../packages/website/docs/modules/guardrails.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-20 | deployed `soat-tests` MCP — create / update / evaluate / versions / delete + attach | 27/37 items verified; the rest unexercised, 2 findings | [#633](https://github.com/ttoss/soat/issues/633) — snake_case `args.*`/`context.*` var paths never resolve, breaking every documented example |
| 2026-07-25 | (incidental, during the audit-log pass) | `guardrails:Evaluate` audit entry shape confirmed — see [`audit-log.md`](./audit-log.md) | none |
| 2026-07-27 | live REST against `soat.naturali.ai`, admin + purpose-built limited principal | 32/37 — closed 5 of the 6 unchecked items (write-time validation, `context_mode`, `soat.activity.*` fail-closed, detach isolation, metadata-only version) | none |

## Write-time validation

- [x] `var` outside `args.* / context.* / soat.*` → `400`
- [x] Out-of-catalog `soat.*` key (e.g. `soat.usage.cost_usd_90d`) → `400`
- [x] `class` literal must be `A`/`B`/`C`/`D`; a non-literal must be JSON Logic
- [x] `guard` must be a JSON Logic object (`"not-an-object"` → `400 VALIDATION_FAILED`, *"'guard' must be a JSON Logic expression"*); `escalate` must be boolean (`"yes"` → `400`); unknown document key → `400` naming the field and listing the allowlist (`class, default_class, guard, escalate, expires_in`). Also confirmed: invalid `default_class` → `400`, missing required `class` → `400`

## Classification

- [x] Class **A** → `execute`
- [x] Class **C** → `route_to_approval`
- [x] Class **D** → `blocked`
- [x] Class expression (`if` over `args`) resolves B vs C
- [x] Invalid class result → `default_class` (verified `D`)
- [x] `default_class` omitted + invalid class → fail-closed to `C`

## Guards (class B)

- [x] Passing guard → `execute`, `guard_result: true`
- [x] Failing guard, no `escalate` → `tripwire`
- [x] Failing guard + `escalate: true` → `route_to_approval`
- [x] Class B with no guard → fail-closed `tripwire`
- [x] `soat.usage.*` resolves live at evaluation time
- [x] Context tool `merge` vs `replace` (`context_mode`) — driven behaviorally, not just by snapshot diff: one document classifying on a **caller**-supplied key, evaluated against the same context tool under both modes. `merge` → caller key survives (`context.callerKey: "callerValue"`), class **C** / `route_to_approval`, `context_source: "merged"`; `replace` → caller key dropped (`null`), class **A** / `execute`, `context_source: "tool"`
- [x] `soat.activity.*` unresolvable → fail-closed — `soat.activity.actions_24h` is in the catalog (so it passes write-time validation) but resolves `null` at evaluation. A document reading `{"if":[{"<":[{"var":"soat.activity.actions_24h"},100]},"A","C"]}` with `default_class: "D"` returned class **D** / `blocked`, **not** the class `A` that a JSON Logic `null → 0` coercion would have produced — the permissive branch was not taken. `context_snapshot` shows the `null` explicitly. Matches the warning at `guardrails.md:140`

## Var-path resolution

- [x] `soat.*` var paths (snake_case, matching the catalog) resolve correctly
- [x] `args.*` / `context.*` var paths authored in **snake_case** resolve — was broken ([#633](https://github.com/ttoss/soat/issues/633)): `caseTransform` camelCased inbound `guardrail_context`/`args` keys while the document `var` string was stored verbatim, so they never matched and every documented class-B example hard-stopped at `tripwire`
- [x] A missing `args` key coerces to `0` under JSON Logic and can silently take the more-permissive branch. Inherent JSON Logic behavior; `default_class` does **not** engage because the expression returned a valid class. Guard key presence explicitly — see the docs warning added by [#633](https://github.com/ttoss/soat/issues/633)

Both #633 findings failed in the **safe** direction (tightening, never loosening),
so neither was a runtime-safety hole — but the primary adoption path was broken.

## Composition / attachment

- [x] Attach at agent scope with only `agents:UpdateAgent`
- [x] Detach requires `guardrails:DetachGuardrail` — isolated with a principal holding `agents:UpdateAgent` but **not** `DetachGuardrail`. Positive control: adding a guardrail id succeeded (`200`), proving the principal can update the agent. Removing one id → `403 FORBIDDEN`, *"Detaching a guardrail requires the guardrails:DetachGuardrail permission"*, with `meta.detached` naming the exact id; removing all → `403` naming both. (`guardrails:AttachGuardrail` is not an action — the policy validator rejects it, confirming attach rides on the carrying resource's update permission as documented)
- [ ] Stricter-wins across project / agent / tool scopes on a live call — *needs a real generation*
- [ ] Client-tool gating at the `requires_action` handoff — *not exercised*

## Versioning / lifecycle

- [x] A `document` write increments `version`; prior docs archived
- [x] `get-guardrail-version` returns the exact archived document
- [x] A metadata-only edit leaves `version` untouched — `name`-only, `description`-only and `context_mode`-only PATCHes each left `version` unchanged; the interleaved positive control (a `document` PATCH) bumped `1 → 2`, so version tracking was live throughout
- [x] Delete while attached → `409`
- [x] Delete after detach → success

## Dry-run evaluation

- [x] Returns the would-be `guardrail_evaluation` record; nothing filed or executed
- [x] `context_snapshot` contains only referenced vars
- [x] Unresolvable `soat.*` in a bare dry-run → fail-closed

## Audit trail

- [x] `guardrails:Evaluate` audit entry written for decision-changing evaluations only, with null `principal_type`/`principal_id`, the guardrail as resource, and `detail.kind: guardrail_evaluation` carrying `decision`, `class`, `scope`, `tool`, `run_id`, `context_source`, `context_snapshot` (verified in the audit-log pass)

## Not covered

The unchecked boxes above are the gap list for the next pass. Both remaining
items need a **live generation** — the 2026-07-27 pass closed everything that
`/evaluate` and the REST surface could reach on their own, and these two are
what is left:

These restate the unchecked boxes above rather than adding new ones — they carry
no checkbox so the coverage count stays honest (every gap is counted once, at its
topical section).

**Stricter-wins composition across scopes on a live generation** — the central
promise of attachment, and the only item here that could silently *loosen*
enforcement if wrong. `/evaluate` cannot reach it: it evaluates a single
guardrail, while composition is by definition the interaction of several applying
to one call. Needs an agent that actually emits a tool call, with guardrails
attached at two or more of the project / agent / tool scopes, asserting one
`guardrail_evaluation` record per guardrail and an effective decision equal to
the strictest (`blocked` > `tripwire` > `route_to_approval` > `execute`).

**Client-tool gating at the `requires_action` handoff** — the client-side
execution path is unverified end-to-end.
