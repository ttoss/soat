# PRD: Expression & Templating Normalization

> Normalizes the mapping/substitution surfaces across the platform: JSON Logic
> mappings, dotted paths, `{param}` / `{{secret:...}}` / `${...}` string
> templates, and formation object expressions (`ref` / `param` / `sub`).
> User-facing reference: [Expressions & Templating](../packages/website/docs/advanced/expressions-and-templating.md).

## Background — pattern inventory

The codebase resolves six distinct pattern families today:

| # | Family | Syntax | Resolved by | Resolution time |
| - | ------ | ------ | ----------- | --------------- |
| 1 | JSON Logic | `{ "var": "input.x" }`, `cat`, `if`, … | `src/lib/jsonLogicMapping.ts` (single shared engine) | run/call time |
| 2 | Dotted paths | `state.a.b`, `output_path: "text"`, `ref_attr: "Id.attr"` | `writeToState`, `resolvePathValue`, `parseRefAttr` | run/call/apply time |
| 3 | Single curly | `{param}` (tool URLs), `{topic}` / `{steps.<name>}` (discussions) | `resolveUrlPathParams`, `discussionEngine.resolveTemplate` | call/turn time |
| 4 | Double curly | `{{secret:sec_...}}` — the **only** valid `{{...}}` form | `src/lib/secrets.ts` (`SECRET_REF_RE`) | call time |
| 5 | Dollar curly | `${Param}` / `${LogicalId}` (formation `sub`), `${body.field}` (tool URLs) | `formationsHelpers`, `resolveBodyParamInterpolations` | apply time / call time |
| 6 | Formation objects | `{ "ref": ... }`, `{ "param": ... }`, `{ "sub": ... }` | `formationsHelpers` | apply time |

### Design position

Full syntax unification is a **non-goal**. The delimiters encode distinct
resolution phases (`${Param}` at apply time vs `{{secret:...}}` at call time
vs `{param}` at invocation), which is exactly what lets
`{ "sub": "Bearer {{secret:${MySecret}}}" }` compose three phases in one
string without escaping rules. `{param}` matches OpenAPI path templating and
`ref`/`param`/`sub` deliberately mirror CloudFormation. Normalization targets
**semantics, naming, validation, and documentation** — not delimiters.

### `input_mapping` assessment (2026-07)

The input side is already normalized and needs **no breaking change**:

- All input mappings (orchestration `input_mapping`, pipeline step `input`)
  run through the same evaluator (`applyInputMapping` in
  `jsonLogicMapping.ts`), with the same `isLogic` operator check and the same
  `preserve` escape hatch.
- Run input is readable as `{"var": "input.<key>"}` in **both** orchestrations
  (state seeds the `input` namespace alongside flat keys) and pipelines —
  one canonical spelling already exists.

Remaining input-side gaps are cosmetic and handled by docs (Phase 0) and a
deprecation of the *flat* orchestration input alias at 1.0 (Phase 4):

- Field naming differs: orchestration nodes say `input_mapping` /
  `output_mapping`; pipeline steps say `input` / `output`.
- Intermediate results live in different namespaces: pipelines auto-expose
  `steps.<id>`; orchestrations require an explicit `output_mapping` write into
  shared state.

The real inconsistency is the **output side**: orchestration `output_mapping`
is a reversed write-path map (`{ artifactKey: "state.path" }`), while pipeline
`output` and tool `output_mapping` are JSON Logic. Three near-identical names,
two shapes, two directions.

## Implementation Status

| Component | Status | Notes |
| --------- | ------ | ----- |
| Unified reference page (`docs/advanced/expressions-and-templating.md`) | ✅ Done | This PR |
| Fix `{{city}}` example in `tools.yaml` | ✅ Done | This PR — `{{city}}` would resolve to a mangled `{...}` remnant |
| Write-time validation: reject non-secret `{{...}}` tokens in tool configs | ❌ Not started | Phase 1 |
| Write-time warning: unknown `{token}` in discussion prompts | ❌ Not started | Phase 1 |
| Auto-namespace node artifacts under `nodes.<id>` in orchestration state | ❌ Not started | Phase 2 (additive) |
| `state_mapping` (JSON Logic output projection) superseding `output_mapping` | ❌ Not started | Phase 3 (breaking, pre-1.0) |
| Canonical URL templating (`{param}` primary, `${body.x}` formation-compat) | ❌ Not started | Phase 4 (docs + lint only) |
| Deprecate flat (non-`input.*`) run-input reads in orchestrations | ❌ Not started | Phase 4, removal at 1.0 |

## Implementation Phases

### Phase 0 — Reference documentation + example fixes ✅ This PR

**Goal:** One page documents every pattern, where it is valid, and when it
resolves; shipped examples stop contradicting the implementation.

**Deliverables:**

- `packages/website/docs/advanced/expressions-and-templating.md` + sidebar
  category `Advanced`.
- `tools.yaml` HTTP example uses `{city}` (was `{{city}}`, which the resolver
  `\{(\w+)\}` turns into `?city={London}` — stray braces).

### Phase 1 — Validation guardrails ❌ Not started

**Goal:** The syntax traps users can hit are caught at write time with a clear
error, instead of producing silently-wrong requests at call time.

**Deliverables:**

- Tool create/update validation (extend the existing `{{secret:...}}`
  validation in `src/lib/tools.ts`): any `{{...}}` token in `execute.url`,
  `execute.headers`, `mcp.url`, `mcp.headers` that is **not**
  `{{secret:sec_...}}` is rejected with a new `INVALID_TEMPLATE_TOKEN`
  domain error (400) naming the token and pointing at `{param}` syntax.
- Discussion create/update: `{token}` in a step prompt that is neither
  `topic`, `transcript`, `steps.<earlier-step>`, nor
  `steps.<earlier-step>.last` produces a validation **warning** (parallel to
  `validate-formation` warnings), not an error — unknown tokens are passed
  through by design.
- `validate-formation`: same non-secret `{{...}}` check inside tool resource
  properties, surfaced as an error with the resource path.
- Red/green tests in `rest/tools.test.ts`, `rest/discussions.test.ts`,
  `rest/formations.test.ts`.

### Phase 2 — `nodes.<id>` artifact namespace (additive) ❌ Not started

**Goal:** Orchestrations gain the pipeline ergonomics — reading an upstream
node's raw artifact without declaring an `output_mapping` — while shared
state stays a curated blackboard.

**Deliverables:**

- After each node executes, its full artifact is recorded at
  `state.nodes.<nodeId>` (alongside, not replacing, `output_mapping` writes).
  Downstream mappings read `{"var": "nodes.summarise.content"}`.
- `nodes` becomes a reserved top-level state key: static validation rejects
  `output_mapping` writes targeting `state.nodes.*` and run inputs named
  `nodes`.
- Size guard: artifacts above the existing per-run state budget are recorded
  as a truncation marker, mirroring `node_executions` behavior.
- Static validation (`orchestrationValidation.ts`) learns that
  `{"var": "nodes.<id>..."}` is satisfied by any upstream node `<id>` —
  same dominator analysis as state-key reachability.
- Docs: orchestrations page + reference page updated; pipelines `steps.<id>`
  and orchestrations `nodes.<id>` documented as the same concept.

### Phase 3 — `state_mapping` output projection (breaking, pre-1.0) ❌ Not started

**Goal:** One mental model for every mapping: **keys are destinations, values
are JSON Logic over a documented context** — for outputs as well as inputs.

**Deliverables:**

- New optional node field `state_mapping`:
  `{ "<state.path>": <JSON Logic over { output, state }> }` — e.g.
  `{ "summary": { "var": "output.content" } }`. Evaluated with the shared
  engine; written with `writeToState`.
- `output_mapping` (`{ artifactKey: "state.path" }`) is auto-converted
  internally to the equivalent `state_mapping` and marked **deprecated** in
  the OpenAPI spec and docs; a node declaring both is a validation error.
- Formation `OrchestrationResourceProperties` accepts `state_mapping`;
  formation validator updated (`formations.yaml` sync rule).
- Migration note in the orchestrations doc; removal of `output_mapping`
  scheduled for 1.0.
- SDK/CLI regeneration; tests for equivalence (every existing
  `output_mapping` fixture re-expressed as `state_mapping` must produce
  identical run state).

### Phase 4 — Canonical forms & 1.0 deprecations ❌ Not started

**Goal:** Docs and validation steer everyone to one spelling per concept;
legacy aliases are removed at 1.0.

**Deliverables:**

- Docs declare `{param}` the canonical tool-URL placeholder; `${body.x}` is
  documented **only** as the formation-`sub`-compatible spelling (it must
  survive `sub` interpolation). No runtime change.
- Docs declare `{"var": "input.<key>"}` the canonical run-input read in
  orchestrations; flat `{"var": "<key>"}` reads of input keys emit a
  validation **warning** and are removed at 1.0 (frees the flat namespace for
  node-written state exclusively).
- `validate-orchestration` / `validate-formation` gain a `deprecations` array
  in their response for these warnings.

## Non-Goals

- Replacing JSON Logic with another expression language (CEL, JMESPath, …).
  The engine is centralized in `jsonLogicMapping.ts`; swapping it is a
  separate decision with its own PRD if ever needed.
- Unifying string-template delimiters (`{}`, `{{}}`, `${}`) — see Design
  position.
- Changing discussion prompt tokens (`{topic}`, `{steps.<name>}`) beyond the
  Phase 1 warning.
- Changing `output_path` on `tool_output` message content — it is harmless
  extraction sugar; `output_mapping` on the tool covers the advanced cases.

## Sequencing & Compatibility

Phases are independent except 3-depends-on-2 conceptually (both touch node
output handling; land 2 first to avoid rebasing churn). Phases 0–2 are fully
backward compatible. Phase 3 keeps `output_mapping` working until 1.0.
Phase 4 removals ship only with the 1.0 major.
