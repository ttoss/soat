# PRD: Expression & Templating Normalization

> Normalizes the mapping/substitution surfaces across the platform: JSON Logic
> mappings, dotted paths, `{param}` / `{{secret:...}}` / `${...}` string
> templates, and formation object expressions (`ref` / `param` / `sub`).
> User-facing reference: [Expressions & Templating](../packages/website/docs/advanced/expressions-and-templating.md).

## Background — pattern inventory

The codebase resolves six distinct pattern families:

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

Per project decision, breaking changes are applied **directly, with no
deprecation period**: this is pre-1.0, so `output_mapping` was renamed to
`state_mapping` and flat run-input reads were removed outright rather than
supported alongside a new form until a future major version.

### `input_mapping` assessment (2026-07)

The input side was already normalized and needed no reshaping:

- All input mappings (orchestration `input_mapping`, pipeline step `input`)
  run through the same evaluator (`applyInputMapping` in
  `jsonLogicMapping.ts`), with the same `isLogic` operator check and the same
  `preserve` escape hatch.
- Run input is readable as `{"var": "input.<key>"}` in **both** orchestrations
  and pipelines — one canonical spelling.

The one input-side change made (Phase 4) was removing the **flat** run-input
alias in orchestrations (`{"var": "<key>"}` reading run input directly) —
`{"var": "input.<key>"}` is now the only way to read run input. This was a
direct breaking change, not a deprecation.

The real inconsistency was the **output side**: orchestration `output_mapping`
was a reversed write-path map (`{ artifactKey: "state.path" }`), while
pipeline `output` and tool `output_mapping` were JSON Logic. Phase 3 replaced
it with `state_mapping`, unifying all three under one evaluator.

## Implementation Status

| Component | Status | Notes |
| --------- | ------ | ----- |
| Unified reference page (`docs/advanced/expressions-and-templating.md`) | ✅ Done | |
| Fix `{{city}}` example in `tools.yaml` | ✅ Done | `{{city}}` would resolve to a mangled `{...}` remnant |
| Write-time validation: reject non-secret `{{...}}` tokens in tool configs | ✅ Done | `INVALID_TEMPLATE_TOKEN` (400); also enforced in `validate-formation` |
| Write-time warning: unknown `{token}` in discussion prompts | ✅ Done | `template_warnings` field on Discussion, computed on every read |
| Auto-namespace node artifacts under `nodes.<id>` in orchestration state | ✅ Done | `writeNodeArtifact`; reserved-key validation |
| `state_mapping` (JSON Logic output projection) superseding `output_mapping` | ✅ Done | Direct breaking rename, no back-compat alias |
| Canonical URL templating (`{param}` primary, `${body.x}` formation-compat) | ✅ Done | Docs only, as planned; no runtime change |
| Flat (non-`input.*`) run-input reads in orchestrations | ✅ Done (removed) | Direct breaking removal, no deprecation warning |

## Implementation Phases

### Phase 0 — Reference documentation + example fixes ✅ Done

**Goal:** One page documents every pattern, where it is valid, and when it
resolves; shipped examples stop contradicting the implementation.

**Delivered:**

- `packages/website/docs/advanced/expressions-and-templating.md` + sidebar
  category `Advanced`.
- `tools.yaml` HTTP example uses `{city}` (was `{{city}}`).

### Phase 1 — Validation guardrails ✅ Done

**Goal:** The syntax traps users can hit are caught at write time with a clear
error, instead of producing silently-wrong requests at call time.

**Delivered:**

- `src/lib/secrets.ts`: `findInvalidTemplateTokens` (pure, shape-only check —
  a `{{...}}` token whose content isn't `secret:sec_...` **or** an unresolved
  formation `secret:${...}` sub placeholder) and `assertNoInvalidTemplateTokens`
  (throws `INVALID_TEMPLATE_TOKEN`, 400).
- Wired into `tools.ts` `validateToolDefinition`/`validateToolUpdate`
  (`execute`/`mcp` fields) and into `toolsFormationModule.ts`'s static
  `validateToolProperties` (same check, pre-resolution, so a template's
  `{{secret:${LogicalId}}}` sub placeholder is correctly accepted before
  deploy-time resolution).
- Discussions: `discussionsValidation.ts` `findDiscussionTemplateWarnings`
  scans participant/synthesis prompts for `{token}`s outside the allowlist
  (`topic`, `transcript`, `steps.deliberation`, `steps.deliberation.last` —
  the only two engine steps a discussion ever compiles to). Surfaced as a
  `template_warnings: string[]` field on the Discussion resource (OpenAPI
  `discussions.yaml`), computed on every create/update/read — not a separate
  validate endpoint.
- Tests: `rest/tools.test.ts`, `rest/discussions.test.ts`,
  `rest/formations.test.ts`.

### Phase 2 — `nodes.<id>` artifact namespace (additive) ✅ Done

**Goal:** Orchestrations gain the pipeline ergonomics — reading an upstream
node's raw artifact without declaring a mapping — while shared state stays a
curated blackboard.

**Delivered:**

- `orchestrationNodesNamespace.ts` (new leaf module, no runtime imports beyond
  a type-only one — avoids a circular dependency between
  `orchestrationNodeExecutors.ts` and `orchestrationValidation.ts`):
  - `writeNodeArtifact` records every completed node's artifact at
    `state.nodes.<nodeId>`, **deep-cloned** before storage. A `transform`
    node's `{"var": ""}` (whole-state reflection) makes its artifact alias
    `state` itself; nesting that live reference under `state.nodes.<id>`
    would make `state` contain itself — a cycle that crashes JSON
    serialization on every run's HTTP response and JSONB checkpoint. Cloning
    breaks the cycle.
  - `checkReservedNodeNamespace`: `nodes` is a reserved top-level state key —
    rejects an `input_schema` property named `nodes` and a `state_mapping`
    write targeting `state.nodes.*`.
- Wired into every artifact-recording call site: `orchestrationExecutors.ts`
  (`processNodeResultBatch`), `orchestrationEngine.ts` (delay-resume),
  `orchestrationRunHelpers.ts` (human/webhook-receive resume).
- `orchestrationValidation.ts`: `classifyNodesRef` extends static reachability
  analysis so `{"var": "nodes.<id>..."}` is checked against the graph's actual
  node ids and ancestor/dominator sets — same dominator analysis as ordinary
  state-key reachability, but unconditionally an error when unwritten (unlike
  ordinary keys, `nodes.<id>` can never come from an open run-input contract).
- **Case-transform fix** (`middleware/caseTransform.ts`): `state`, `artifacts`,
  and `output` added to the orchestration-run response pass-through
  (alongside the pre-existing `input`). Node ids are caller-authored
  identifiers referenced verbatim in `{"var": "nodes.<id>..."}` — the
  pre-existing `input` pass-through's rationale ("case-transforming an
  author's own key would desync the response from what the graph reads")
  applies identically to `nodes.<nodeId>` keys.
- Docs: orchestrations page (`#the-nodesid-namespace`-equivalent section) +
  reference page; pipelines `steps.<id>` and orchestrations `nodes.<id>`
  cross-referenced as the same concept.
- Not implemented: a size/truncation guard for oversized artifacts. No
  existing precedent for this exists anywhere in the orchestration engine
  (the sibling `artifacts` map is equally unbounded), so inventing one
  here would be speculative infrastructure outside this PRD's scope.

### Phase 3 — `state_mapping` output projection (breaking, direct) ✅ Done

**Goal:** One mental model for every mapping: **keys are destinations, values
are JSON Logic over a documented context** — for outputs as well as inputs.

**Delivered:**

- `OrchestrationNode.outputMapping?: Record<string, string>` renamed directly
  to `stateMapping?: Record<string, unknown>` (`orchestrations.ts`) — no
  dual-field support.
- `applyOutputMapping` (dotted-path writer) replaced by `applyStateMapping`
  (`orchestrationNodeExecutors.ts`): evaluates each `state_mapping` value as
  JSON Logic against `{ output: <artifact>, state: <run state> }`, then writes
  via the same `writeToState` dotted-path builder as before.
- `orchestrations.yaml`: `output_mapping` field replaced with `state_mapping`
  (`additionalProperties: true`, JSON Logic values documented).
- `checkReservedNodeNamespace` / `writtenStateKeys`
  (`orchestrationValidation.ts`) updated for the shape flip: a
  `state_mapping`'s own **keys** are its write destinations (previously the
  **values** were).
- SDK/CLI regenerated (no diff in committed files — both are gitignored
  build artifacts).
- Every call site (`orchestrationExecutors.ts`, `orchestrationEngine.ts`
  delay-resume, `orchestrationRunHelpers.ts` human/webhook resume) updated.
- Tests: all existing `output_mapping` fixtures across
  `rest/orchestrations.test.ts`, `rest/formations.test.ts`,
  `rest/triggers.test.ts`, `rest/mcp.test.ts`,
  `lib/orchestrationScheduler.test.ts`, `lib/formation-modules.test.ts`,
  `lib/triggerScheduler.test.ts`, `lib/orchestrationNodeExecutors.test.ts`,
  `lib/orchestrationValidation.test.ts` mechanically re-expressed as
  `state_mapping` and re-verified to produce identical run state.
- Docs: `orchestrations.md` (State and Mappings, Evaluation scope, Static
  Validation, Agent Squad, all examples) and
  `expressions-and-templating.md` rewritten — `state_mapping` moved from the
  "Dotted paths" family into "JSON Logic" (only its keys are dotted; its
  values are expressions).
- Tutorials (`orchestration-control-flow.md`, `automate-a-flow-with-triggers.md`,
  `orchestrate-a-sonnet.md`, `create-an-agent-squad.md`,
  `conditional-orchestration.md`) updated — these are executable,
  CI-tested docs, so the old field name would have 400'd every orchestration
  create in them.

### Phase 4 — Canonical forms, applied directly (no deprecation) ✅ Done

**Goal:** One spelling per concept, applied as a direct breaking change rather
than a deprecation-then-removal cycle.

**Delivered:**

- `{param}` documented as the canonical tool-URL placeholder; `${body.x}`
  documented as the formation-`sub`-compatible spelling. Docs only, no
  runtime change (both continue to work; they resolve at different times and
  compose, per the Design position above).
- `startOrchestrationRun` (`orchestrationEngine.ts`): run input is now seeded
  **only** under `state.input`. The flat top-level spread
  (`{ ...runInput, input: runInput }` → `{ input: runInput }`) was removed
  directly — no warning period.
- `orchestrationValidation.ts` `classifyRef`: the `ctx.inputKeys.has(key)`
  shortcut (which treated a flat `{"var": "<name>"}` as satisfied whenever
  `input_schema` declared `<name>`) was removed. A flat reference is now
  always `unwritten` unless some upstream node's own `state_mapping` writes
  that exact flat key — matching the runtime reality.
- Not implemented: a `deprecations` array on `validate-orchestration`/
  `validate-formation` responses — that is deprecation-warning tooling,
  explicitly out of scope per the "no deprecation" directive.

**Fixture/test migration required by this phase** (breaking change, no
back-compat): every orchestration node reading run input via a flat
`{"var": "<name>"}` was updated to `{"var": "input.<name>"}` across
`rest/orchestrations.test.ts`, `lib/orchestrationValidation.test.ts`,
`lib/formation-modules.test.ts`, `rest/formations.test.ts`, and the five
tutorials listed under Phase 3.

## Non-Goals

- Replacing JSON Logic with another expression language (CEL, JMESPath, …).
  The engine is centralized in `jsonLogicMapping.ts`; swapping it is a
  separate decision with its own PRD if ever needed.
- Unifying string-template delimiters (`{}`, `{{}}`, `${}`) — see Design
  position.
- Changing discussion prompt tokens (`{topic}`, `{steps.<name>}`) beyond the
  Phase 1 warning.
- Changing `output_path` on `tool_output` message content — it is harmless
  extraction sugar; tool `output_mapping` (a distinct, unchanged concept)
  covers the advanced cases.
- A size/truncation guard on `state.nodes.<id>` artifacts (see Phase 2).
- A `deprecations` array on validate endpoints (see Phase 4) — deprecation
  tooling is out of scope; issues are raised as errors or warnings directly.

## Compatibility

All four phases shipped as **direct breaking changes** in one PR, per project
decision (pre-1.0, no deprecation window required). There is no
`output_mapping`/flat-run-input compatibility shim: any external caller,
formation template, or tutorial using the old field name or flat run-input
reads must migrate to `state_mapping` / `{"var": "input.<name>"}`.
