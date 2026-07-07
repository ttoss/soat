# PRD: Existing Module Enhancements — Docs, Spec, and Contract Consistency Sweep

One-line summary: bring the 27 shipped module pages, their OpenAPI specs, and the generated client surface back into full agreement with the runtime, eliminating the three systemic drift classes found in the 2026-07 documentation audit.

## Implementation Status

| Workstream | Status |
| --- | --- |
| WS1 — OpenAPI spec corrections (code-facing) | Not started |
| WS2 — Public-ID prefix alignment | Not started |
| WS3 — Stale feature-rename sweep | Not started |
| WS4 — Phantom API surface removal | Not started |
| WS5 — Doc-standard compliance | Not started |
| WS6 — Example-block discipline | Not started |
| WS7 — Drift guardrails (automation) | Not started |

## Problem

A full audit of the 27 module pages under `packages/website/docs/modules/` (2026-07-06), with spot-checks against `packages/server/src/rest/openapi/v1/*.yaml`, `packages/server/src/permissions/*.json`, and runtime code, found that field-level accuracy is strong (average grade 8.2/10) but three systemic drift classes and a tail of per-page defects cost most of the lost points:

1. **The declared source of truth is sometimes the stale artifact.** In two verified cases the markdown matches the implementation while the OpenAPI YAML — which generates the SDK, CLI manifest, and MCP tool surface — does not. `secrets.yaml` documents a decrypted `value` field in the get-secret response that `src/lib/secrets.ts` never returns, and `ai-providers.yaml` restricts the provider enum to 5 slugs while `packages/postgresdb/src/models/AiProvider.ts` (`AI_PROVIDER_SLUGS`) and the module doc both list 10. Anyone coding against the generated SDK types gets a wrong contract.
2. **Public-ID prefixes have no enforced source of truth.** Docs and even OpenAPI `example:` values use `agt_`, `act_`/`actr_`, `trc_`, `me_`, `tol_`, `fl_`, `run_`, `af_`/`afr_`/`afo_` while the runtime registry (`packages/postgresdb/src/utils/publicId.ts`) generates `agent_`, `actor_`, `trace_`, `mem_entry_`, `tool_`, `file_`, `orch_run_`, `form_`/`form_res_`/`form_op_`. Three docs give three different prefixes for the same actor resource (`act_`, `actr_`, vs runtime `actor_`).
3. **Renamed or removed features survive in older pages.** `documents:SearchDocuments` / `search-documents` (now `knowledge:SearchKnowledge` / `search-knowledge`) still appears in `iam.md`, `tools.md`, `agents.md`, and `tutorials/agent-soat-tools.md` — including inside a flagship example that the tools page's own validation section says would be rejected with `400 VALIDATION_FAILED`. `documents.md` still describes a project-membership authorization gate that the policy-only model replaced. `actors.md` and `conversations.md` document API surface (`type` field, three actor sub-endpoints) that exists in no router or spec.

Newer modules (discussions, sessions, memories) audited markedly cleaner than older ones (traces, conversations, actors, oauth), confirming this is accumulated drift, not a broken authoring process.

## Goals

- The OpenAPI specs match runtime behavior for every field they document; the generated SDK/CLI/MCP surface is regenerated from the corrected specs.
- Every ID example in docs and specs uses the prefix the runtime actually generates.
- No module page documents an action, endpoint, field, or behavior that does not exist.
- Every module page satisfies the current doc standard (structure, tabbed examples, permissions-reference link).
- Automated checks prevent the three drift classes from re-accumulating.

## Non-Goals

- No new features or behavioral API changes. Where a doc describes surface that does not exist (actor `type`, conversation actor sub-endpoints), the doc is corrected; building that surface would be a separate PRD.
- No restructuring of the docs site or the module-page template itself.
- No changes to the permission model or policy engine.

## WS1 — OpenAPI Spec Corrections (code-facing, do first)

The spec is the generation source for `@soat/sdk`, the CLI route manifest, and the MCP tool surface, so these fixes ship with regenerated clients and tests. Per the repo's red/green rule, each fix starts with a failing REST test asserting the real response shape.

| Spec | Defect | Fix |
| --- | --- | --- |
| `secrets.yaml` | Get-secret response documents a decrypted `value` field ("Decrypted secret value") that `lib/secrets.ts` never returns | Remove `value` from the get response; add `has_value` (boolean) and `updated_at`, which the lib returns and the module doc already documents |
| `ai-providers.yaml` | Provider enum is `[openai, anthropic, google, cohere, mistral]`; runtime `AI_PROVIDER_SLUGS` has 10 slugs | Sync the enum (both occurrences) to the runtime list; add missing `updated_at` to responses |
| `tools.yaml` vs `tools.md` | Doc documents `discussion` as an object `{ discussion_id }`; spec defines a top-level `discussion_id` string | Spec is correct — fix the doc (tracked here because the divergence was found spec-side) |

Steps per `modules.md`: update yaml → `pnpm --filter @soat/sdk generate` → `pnpm --filter @soat/cli generate` → REST tests green.

**Acceptance criteria**

- A REST test asserts `GET /api/v1/secrets/{secret_id}` returns `has_value` and never `value` (red first against the current spec-derived expectation, then green).
- A REST test (or existing test extended) accepts creating an AI provider with each of the 10 runtime slugs.
- `git diff` of `packages/sdk/src/generated/` and the CLI manifest reviewed and committed in the same PR as the yaml change.

## WS2 — Public-ID Prefix Alignment

Decision: `PUBLIC_ID_PREFIXES` in `packages/postgresdb/src/utils/publicId.ts` is the single source of truth. Docs and OpenAPI `example:` values are corrected to it; the registry itself does not change (changing generated prefixes would break existing rows).

Known wrong→right mappings to sweep across `packages/website/docs/**` and `packages/server/src/rest/openapi/v1/*.yaml`:

| Wrong (found in docs/spec examples) | Right (runtime) | Known locations |
| --- | --- | --- |
| `agt_`, `agt_gen_`, `agt_trace_` | `agent_`, `gen_`, `trace_` | agents.md, traces.md, iam.md, yaml examples |
| `act_`, `actr_` | `actor_` | actors.md, sessions.md, iam.md |
| `trc_` | `trace_` | traces.md |
| `me_` | `mem_entry_` | memories.md, knowledge.md |
| `tol_` | `tool_` | ingestion-rules.md (+ its yaml examples) |
| `fl_` | `file_` | ingestion-rules.md |
| `run_` | `orch_run_` | orchestrations.md |
| `af_`, `afr_`, `afo_` | `form_`, `form_res_`, `form_op_` | formations.md (+ yaml examples) |
| `prj_` (mixed with correct `proj_`) | `proj_` | formations.md |

**Acceptance criteria**

- `grep -rnE "\b(agt_|trc_|actr_|act_[0-9A-Za-z]|tol_|fl_[0-9A-Za-z]|af_[0-9A-Za-z]|afr_|afo_|prj_)" packages/website/docs packages/server/src/rest/openapi` returns zero hits (pattern refined at implementation time to avoid false positives).
- Every `example:` ID value in `packages/server/src/rest/openapi/v1/*.yaml` starts with a prefix present in `PUBLIC_ID_PREFIXES` (enforced by the WS7 test).

## WS3 — Stale Feature-Rename Sweep

| Stale reference | Current reality | Locations |
| --- | --- | --- |
| `documents:SearchDocuments` permission action | `knowledge:SearchKnowledge` | iam.md (2 examples), agents.md (`boundary_policy` example) |
| `search-documents` soat-tool action | `search-knowledge` | tools.md (data model, prose, flagship create example), agents.md (Example 6), tutorials/agent-soat-tools.md |
| "the server checks project membership before evaluating policies" / "projects the user is a member of" | Authorization is policy-only; `src/middleware/auth.ts` resolves projects from policies | documents.md ("Project ID Resolution") |
| API keys "can optionally be scoped to a single project" | Keys are always scoped to their `project_id` (iam.md says so itself two sections later) | iam.md (Authentication section) |
| Changelog-style phrasing ("no longer", "has been removed", "moved to Discussions") describing history instead of current state | Rewrite as present-tense statements of current behavior; migration recipes may stay but marked as migration notes | agents.md, projects.md, discussions.md |

**Acceptance criteria**

- `grep -rn "SearchDocuments\|search-documents" packages/` returns zero hits.
- `grep -rn "membership" packages/website/docs/modules/documents.md` returns zero hits describing an authorization gate.
- iam.md contains a single, consistent statement of API-key project scoping.

## WS4 — Phantom API Surface Removal

Decision: the shipped API is the contract; docs are corrected to it. If the removed surface is genuinely wanted, it gets its own feature PRD — it is not resurrected by documentation.

| Phantom surface | Locations | Fix |
| --- | --- | --- |
| `type` field on actor create (sent in every tab of both create examples; repeated in prose) — absent from `actors.yaml` | actors.md, conversations.md | Remove the field from examples and prose |
| `GET /conversations/{conversation_id}/actors`, `POST /agents/{agent_id}/actors`, `POST /chats/{chat_id}/actors` — absent from every router and spec | conversations.md | Remove; replace with the real actor-association flow documented in actors.md |
| `users.md` claims user management covers "create, update, delete" — no update operation or `users:UpdateUser` exists | users.md | Drop "update" from the claim |
| Speculative "Future Extensions" section | conversations.md | Remove (roadmap lives in PRDs, not module reference pages) |

**Acceptance criteria**

- Every endpoint, field, and permission action referenced in the four pages exists in the corresponding yaml/permissions JSON (verified by review checklist in the PR).

## WS5 — Doc-Standard Compliance

Per-page structural fixes against the current module-page standard (overview, data model, key concepts, permissions-reference link, tabbed CLI/SDK/curl examples; no REST endpoint documentation in module pages):

| Page | Fix |
| --- | --- |
| oauth.md | Largest gap (graded 6/10): remove the `## Endpoints` REST table, add tabbed Examples, add the permissions-reference callout, rewrite the "Data model" table to describe API-facing fields rather than in-memory storage internals; keep the flow diagram and design rationale |
| generations.md | Add the missing `## Examples` section (all three tabs); resolve the `initiator_generation_id` contradiction (data-model row vs final section — yaml says sub-agent invocations only) |
| docs.md | Add a data-model/parameters presentation consistent with other stateless modules (embeddings.md is the model) and an explicit access-rules statement |
| formations.md | Add the standard permissions-reference callout line |
| agents.md | Remove the "Generation Endpoints" REST section (belongs to the API reference) |
| policies.md | Remove endpoint paths from prose/HTTP blocks; fix `:userId` → `{user_id}` |
| iam.md | Define (or remove) the `version` field appearing in policy examples; fix the `act_123` SRN example (WS2) |
| orchestrations.md | Make Node Types / Loops / State-and-Mappings tables snake_case, matching the doc's own JSON examples and its own assertion that node fields are snake_case |
| api-keys.md | Remove the internal-integer-ID storage remark (`policy_ids` "stores integer internal IDs") — internal DB IDs must never be documented |
| webhooks.md | Fix "project policy" → policies are global resources (align terminology with policies.md) |
| ai-providers.md | Resolve the Bedrock callout self-contradiction ("must be stored as a JSON object… plain strings work as a convenience") |
| documents.md | Replace the `(doc.metadata as any)?.failure_reason` SDK example with a type-narrowed access — the repo's own quality rules forbid `as any` |
| ingestion-rules.md | Keep the converter-contract section but link the callback endpoint to the API reference instead of re-documenting another module's REST surface |

**Acceptance criteria**

- `grep -rn " as any\| as unknown" packages/website/docs` returns zero hits.
- `grep -rnE ":([a-z]+[A-Z][a-zA-Z]*)" packages/website/docs/modules docs/prd-*.md` returns zero camelCase path params.
- Each listed page re-verified against the template checklist in the PR description.

## WS6 — Example-Block Discipline

| Page | Fix |
| --- | --- |
| secrets.md | Create examples must include the required `value` field (currently they would 400) |
| files.md | CLI example `soat create-upload-token` → `soat create-presigned-url` (the page's own MCP section already uses the correct name); reconcile the "local filesystem storage backend" title with the `local`/`s3`/`gcs` backend prose |
| traces.md | Use the house SDK style (`new SoatClient({ baseUrl, token })` + typed methods, not `createSoatClient` + `client.GET`); add the missing curl tab; make CLI flags consistently kebab-case |
| knowledge.md | Add the missing SDK tabs (2 of 4 blocks); make the "Document-scoped retrieval" example actually pass a document filter; rewrite the "Search Modes" paragraph to stop contradicting the Overview |
| chats.md | Add a per-chat (`/chats/{chat_id}/completions`) example — the module's headline feature has no example; drop or fold the negative-definition "Tool Output Selection" section |
| conversations.md | Use one SDK style throughout (typed methods) |
| discussions.md | CLI tab of "Create a discussion" must include participants like the SDK/curl tabs |
| webhooks.md, api-keys.md, sessions.md | Add a read/list example alongside the create example (standard asks for the primary operation plus one read) |

**Acceptance criteria**

- Every example block in the touched pages has all three tabs (CLI/SDK/curl) unless the operation genuinely has no CLI equivalent.
- Every documented CLI command name matches the generated route manifest (kebab-cased operationId).
- Every create example includes all fields the spec marks `required`.

## WS7 — Drift Guardrails (automation)

Prevent recurrence mechanically rather than by review discipline:

1. **Prefix-validation test** — a unit test in `packages/server/tests/unit/tests/lib/` that loads every `packages/server/src/rest/openapi/v1/*.yaml`, extracts string `example:` values matching `^[a-z][a-z0-9_]{1,10}_[A-Za-z0-9]+$`, and asserts the prefix is in `PUBLIC_ID_PREFIXES` (plus the documented non-entity prefixes: `sk_`, `srn:`). This qualifies as a `lib/` test under the keep-list rule: pure validation with no REST entry point.
2. **Docs lint script** — a repo script (wired into CI alongside `build-and-test`) that greps `packages/website/docs` for: forbidden casts (` as any`, ` as unknown`), camelCase path params (`:paramName`), and the stale-term denylist maintained in the script (`search-documents`, `SearchDocuments`, wrong prefixes from WS2). Denylist entries are removed once the term is legitimately reintroduced.
3. **Doc-page checklist in PR template** — the module checklist in `.claude/rules/modules.md` already requires doc updates; add one line: "ID examples use runtime prefixes (`publicId.ts`)".

**Acceptance criteria**

- Both checks run in CI and fail on seeded violations (verified red before the sweep lands, green after — the sweep PRs make them pass).

## Rollout / Phasing

| Phase | Contents | Rationale |
| --- | --- | --- |
| 1 | WS1 (spec corrections + regen + tests) | Code-facing; unblocks correct SDK types; smallest and highest-value |
| 2 | WS7 checks landed red-gated on a branch, then WS2 + WS3 + WS4 sweeps make them green | Mechanical, high-volume, low-judgment; guardrails prove completeness |
| 3 | WS5 + WS6 per-page fixes | Judgment work, page by page; can ship incrementally |

Each phase is one PR (Phase 3 may split by page group). No migrations, no new permissions, no new tables.

## Risks

- **SDK regeneration surfaces breaking type changes** (removing `value` from the secrets get response narrows a generated type). Mitigation: this is a correction toward runtime truth — the field was never populated; call it out in the changelog as a spec fix, not an API change.
- **Grep-based acceptance patterns over- or under-match** (e.g. `me_`, `act_` substrings). Mitigation: patterns are refined at implementation time and enforced by the WS7 script, which owns the canonical regexes.
- **Docs churn conflicts with in-flight feature PRs.** Mitigation: Phase 2 sweeps are mechanical and rebased trivially; coordinate Phase 3 page edits with any open PRs touching the same pages.
