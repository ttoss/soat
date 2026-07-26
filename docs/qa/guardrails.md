# QA checklist — guardrails

Module docs: [`packages/website/docs/modules/guardrails.md`](../../packages/website/docs/modules/guardrails.md)
Checkbox semantics and how to run a pass: [`README.md`](./README.md)

## Run history

| Date | Surface | Result | Defects filed |
|---|---|---|---|
| 2026-07-20 | deployed `soat-tests` MCP — create / update / evaluate / versions / delete + attach | 27/37 items verified; the rest unexercised, 2 findings | [#633](https://github.com/ttoss/soat/issues/633) — snake_case `args.*`/`context.*` var paths never resolve, breaking every documented example |
| 2026-07-25 | (incidental, during the audit-log pass) | `guardrails:Evaluate` audit entry shape confirmed — see [`audit-log.md`](./audit-log.md) | none |

## Write-time validation

- [x] `var` outside `args.* / context.* / soat.*` → `400`
- [x] Out-of-catalog `soat.*` key (e.g. `soat.usage.cost_usd_90d`) → `400`
- [x] `class` literal must be `A`/`B`/`C`/`D`; a non-literal must be JSON Logic
- [ ] `guard` must be a JSON Logic object; `escalate` must be boolean; unknown document keys rejected — *not exercised*

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
- [ ] Context tool `merge` vs `replace` (`context_mode`) — *not exercised, needs a context tool*
- [ ] `soat.activity.*` unresolvable → fail-closed — *documented, not exercised live*

## Var-path resolution

- [x] `soat.*` var paths (snake_case, matching the catalog) resolve correctly
- [x] `args.*` / `context.*` var paths authored in **snake_case** resolve — was broken ([#633](https://github.com/ttoss/soat/issues/633)): `caseTransform` camelCased inbound `guardrail_context`/`args` keys while the document `var` string was stored verbatim, so they never matched and every documented class-B example hard-stopped at `tripwire`
- [x] A missing `args` key coerces to `0` under JSON Logic and can silently take the more-permissive branch. Inherent JSON Logic behavior; `default_class` does **not** engage because the expression returned a valid class. Guard key presence explicitly — see the docs warning added by [#633](https://github.com/ttoss/soat/issues/633)

Both #633 findings failed in the **safe** direction (tightening, never loosening),
so neither was a runtime-safety hole — but the primary adoption path was broken.

## Composition / attachment

- [x] Attach at agent scope with only `agents:UpdateAgent`
- [ ] Detach requires `guardrails:DetachGuardrail` — *not isolated; the test user carried the permission*
- [ ] Stricter-wins across project / agent / tool scopes on a live call — *needs a real generation*
- [ ] Client-tool gating at the `requires_action` handoff — *not exercised*

## Versioning / lifecycle

- [x] A `document` write increments `version`; prior docs archived
- [x] `get-guardrail-version` returns the exact archived document
- [ ] A metadata-only edit leaves `version` untouched — *not exercised*
- [x] Delete while attached → `409`
- [x] Delete after detach → success

## Dry-run evaluation

- [x] Returns the would-be `guardrail_evaluation` record; nothing filed or executed
- [x] `context_snapshot` contains only referenced vars
- [x] Unresolvable `soat.*` in a bare dry-run → fail-closed

## Audit trail

- [x] `guardrails:Evaluate` audit entry written for decision-changing evaluations only, with null `principal_type`/`principal_id`, the guardrail as resource, and `detail.kind: guardrail_evaluation` carrying `decision`, `class`, `scope`, `tool`, `run_id`, `context_source`, `context_snapshot` (verified in the audit-log pass)

## Not covered

The unchecked boxes above are the gap list for the next pass. The largest ones,
in priority order:

- [ ] **Stricter-wins composition across scopes on a live generation** — the
  central promise of attachment, and the only item here that could silently
  *loosen* enforcement if wrong.
- [ ] **Client-tool gating at the `requires_action` handoff** — the client-side
  execution path is unverified end-to-end.
- [ ] **Context tool `merge` vs `replace`** — needs a purpose-built context tool.
- [ ] **Permission isolation for detach** — needs a principal that lacks
  `guardrails:DetachGuardrail`.
