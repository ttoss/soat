# OpenAPI Spec Drift Audit

Complete enumeration of the pre-existing drift between the OpenAPI specs
(`packages/server/src/rest/openapi/v1/*.yaml`) and the responses the server
actually returns — the burn-down noted in
`packages/server/tests/unit/openapiContract.ts` and flagged as a v1 RC risk in
the roadmap review: the specs are the frozen v1 contract *and* the source of
the SDK, CLI, and MCP tool surfaces, so every item below is a place where the
generated clients promise something the server does not do.

## Methodology

The contract validator gained an opt-in audit mode
(`OPENAPI_DRIFT_AUDIT_FILE=<path>`): every `application/json` response
produced by the full server test suite (5768 tests, 203 files) is validated
against its documented `(path, method, status)` schema, and violations are
appended as JSONL instead of failing the test. CI never sets the variable, so
enforcement behavior is unchanged.

Run: `OPENAPI_DRIFT_AUDIT_FILE=/tmp/drift.jsonl pnpm --filter @soat/server test`

Raw numbers from the 2026-08-13 run:

| Metric | Value |
|---|---|
| Non-conforming responses | 1,305 |
| Individual schema violations | 3,447 |
| Endpoint + status combinations affected | 307 |
| **Distinct root causes** | **10 groups below** |

The ~1900 figure in the validator's doc comment was the raw failure count of
the first (abandoned) full-surface attempt; the same drift, counted here as
deduplicated root causes, collapses to the groups below.

## Group 1 — Error envelope: every documented error response is wrong

**274 endpoint/status combinations — by far the largest group, and one fix.**

Every spec file defines `ErrorResponse` as:

```yaml
ErrorResponse:
  type: object
  properties:
    error:
      type: string
```

The server (per `.claude/rules/errors.md`, enforced by
`errorLogger.ts`) always returns the structured envelope:

```json
{ "error": { "code": "RESOURCE_NOT_FOUND", "message": "…", "meta": { } } }
```

Affected: essentially all documented `400/401/403/404/409` responses across
all 36 spec files (each yaml carries its own copy of the wrong
`ErrorResponse`). Full endpoint/status list: 274 entries, all with the same
signature (`/error` must be `string`).

**Fix:** replace every per-file `ErrorResponse` schema with the real shape
(`error: { code, message, meta? }`, `code` from the `ERROR_CODES` registry).
Mechanical, high-value: SDK/CLI/MCP consumers currently get a wrong type for
every error they handle.

## Group 2 — Tag/metadata write endpoints: spec says "returns the map", server returns the whole resource

The `PUT`/`PATCH` tag endpoints (and `PATCH …/metadata` for files) document
the response as the bare key-value map
(`type: object, additionalProperties: {type: string}`), but the handlers
return the **full updated resource**. Every non-string field of the resource
then violates `additionalProperties: {type: string}` — this explains the
`/size`, `/name`, `/tags`, `/metadata`, `/agent_id`, `/chat_id`, `/actor_id`,
`/instructions`, `/memory_id` "must be string" failures.

Affected endpoints (8):

- `PUT` + `PATCH /api/v1/actors/{actor_id}/tags`
- `PUT` + `PATCH /api/v1/conversations/{conversation_id}/tags`
- `PUT` + `PATCH /api/v1/documents/{document_id}/tags`
- `PUT` + `PATCH /api/v1/files/{file_id}/tags`
- `PATCH /api/v1/files/{file_id}/metadata`

(The `GET …/tags` endpoints conform — they really do return the map.)

**Decision needed before the fix:** either document the full resource
(matches current behavior; additive-feeling but changes the generated return
types) or change the handlers to return the map (matches the docs; a
behavioral break). This must be settled **before** the v1 freeze.

## Group 3 — Nullable-in-practice fields typed as non-nullable

The classic drift called out in the validator's comment. Fields that are
`null` in real responses but typed as plain `string`/`object`:

| Field | Endpoints |
|---|---|
| `description` | `GET/POST/PUT /api/v1/policies`, `GET /api/v1/policies/{policy_id}` |
| `name` | `POST /api/v1/policies`, conversation responses |
| `secret_id` | `GET /api/v1/ai-providers/{ai_provider_id}` |
| `metadata` | file responses (`GET/POST /api/v1/files*`, upload routes) — also mistyped, see Group 5 |

**Fix:** mark `nullable: true` (or the union type) in the specs. Purely
spec-side.

## Group 4 — `File.size`: integer in the spec, string on the wire

`files.yaml` declares `size: type: integer`, but the server returns it as a
**string** (Sequelize `BIGINT` is serialized as a string by default).
Affected: `GET /api/v1/files`, `GET /api/v1/files/{file_id}`,
`POST /api/v1/files` (and the upload routes).

**Decision needed:** cast to number in the mapper (breaks any consumer
already parsing the string; correct for files < 2^53) or document as string
(safe for huge files, awkward ergonomics). Contract-shaping — settle before
the freeze.

## Group 5 — `File.metadata` typed as `string`

The file schemas declare `metadata: type: string`, but the server returns a
key-value **object**. Affected: all file read/write routes that echo the
resource. Spec-side fix (`type: object`, `additionalProperties`), plus
nullability per Group 3.

## Group 6 — Formation template echo vs `*ResourceProperties` oneOf

`GET/POST/PUT /api/v1/formations*` echo the stored `template`, whose
`resources.*.properties` is documented as a `oneOf` over all
`*ResourceProperties` schemas. Real templates fail every branch. Leaf causes
observed:

- `name` is `null` in stored templates but several `*ResourceProperties`
  require a non-null `name` (or don't declare it, making it an undeclared
  property in strict branches).
- Case/eval resources: `input` (object) and `dataset_id` typed/`required`
  inconsistently with what the API accepts and echoes (`expected_output`,
  `pass_threshold`, `scorers`, `agent_id` undeclared in the matching branch).
- Tool resources: `execute` (object with `url`) not declared in the branch
  that otherwise matches.
- Guardrail resources: `class`, `guard`, `context_mode`, `default_class`,
  `context_tool_id` (nullable) missing from the branch.
- Agent resources: `ai_provider_id` (nullable), `instructions` missing.
- Key/secret resources: `value` echoed but not declared.

Because a `oneOf` failure cascades (Ajv reports every branch), this group
alone accounts for most of the 3,447 raw violations. The real work is a
field-by-field reconciliation of `formations.yaml`'s `*ResourceProperties`
against the formation modules' actual `read`/echo output — the same schemas
that act as the formation-template allowlist, so fixing them also fixes
`update-formation` validation gaps.

## Group 7 — Orchestration node `expression` / `reasoning` typed as `object`

`orchestrations.yaml` types `expression` (and `reasoning`,
`exit_condition`) as `type: object` ("JSON Logic rule"), but a JSON Logic
rule is any JSON value — the suite stores scalars/strings and the server
echoes them. Affected: `POST/PATCH /api/v1/orchestrations`, version
restore/read routes.

**Fix:** drop the `type: object` constraint (free-form schema `{}` with the
description), since JSON Logic is by definition untyped.

## Group 8 — Orchestration enums out of date

- `nodes[].type` enum in the response schema is missing at least one node
  type the API accepts (`POST /api/v1/orchestrations` echoed a node whose
  `type` is outside
  `[agent, tool, transform, knowledge, memory_write, condition, human,
  approval, loop, poll, delay, webhook, emit_event, sub_orchestration]`).
- `required_action.type` on orchestration runs is missing values beyond
  `[human_input, webhook_receive]`, and `required_action`'s null/object
  union does not validate (`GET/POST /api/v1/orchestration-runs*`).

**Fix:** regenerate both enums from the source-of-truth TypeScript unions —
and note the enum will grow again; consider documenting them as open enums.

## Group 9 — `POST /api/v1/sessions/{session_id}/messages` response matches no branch

The 201 response schema is a `oneOf`/`anyOf` that the actual response body
does not satisfy at the root. Needs a look at the handler's actual return
shape vs the documented union (likely a missing discriminator branch).

## Group 10 — `POST /api/v1/tools/{tool_id}/call` result typed `object|null`

The response is documented as `["object","null"]` at the root, but a tool
call can return any JSON value (string, array, number). Spec-side fix:
free-form result schema.

## Suggested burn-down order

1. **Group 1** (one mechanical sweep over all 36 yamls; biggest client-facing
   win) — spec-only.
2. **Groups 3, 5, 7, 10** — spec-only nullability/typing corrections.
3. **Groups 4 and 2** — need a product decision (string vs integer; map vs
   resource) **before the v1 freeze**, since both fixes are breaking in one
   direction.
4. **Group 8** — regenerate enums; decide open-vs-closed enum policy for v1.
5. **Group 6** — formations reconciliation (largest real work item).
6. **Group 9** — investigate, then fix spec or handler.

After each step, re-run the audit; when it comes back empty, flip the
validator to full-surface enforcement (and eventually
`additionalProperties: false`) so drift cannot re-accumulate — that is the
deterministic guarantee the v1 freeze needs.

## Reproducing

```bash
OPENAPI_DRIFT_AUDIT_FILE=/tmp/drift.jsonl pnpm --filter @soat/server test
# then aggregate /tmp/drift.jsonl (JSONL: {method, template, status, errors[]})
```

Known environmental caveat: `rest/files.test.ts` ("user with permission
receives a token, url and expiry") fails when `SOAT_BASE_URL` is set in the
environment — unrelated to drift; unset the variable when running locally.
