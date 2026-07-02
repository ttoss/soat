# PRD: Pluggable File Ingestion (Converter Rules)

## Problem

Today `POST /api/v1/documents/ingest` can only turn a file into a document when the file's text can be extracted directly. The source format is detected from `content_type` and handled by a hard-coded branch in `extractSourcePages()` (`packages/server/src/lib/documentIngestion.ts`):

| Content type      | Handling                                   |
| ----------------- | ------------------------------------------ |
| `application/pdf` | Text-layer extraction via `unpdf` (no OCR) |
| `text/plain`      | Read as a single source page               |
| `text/markdown`   | Read as a single source page               |
| anything else     | Rejected with `UNSUPPORTED_FILE_TYPE`      |

Two gaps follow directly from this:

1. **Scanned PDFs / images fail.** `unpdf` returns no text for image-only PDFs and photos, so the document lands in `failed` with `FILE_PARSE_FAILED`.
2. **Audio and every other modality is unsupported.** There is no path from an `.mp3`/`.wav`/`.png`/`.tiff` file to a searchable document.

The maintainers do not want to build OCR or speech-to-text into the server. SOAT already has a **tools** module whose `http`, `mcp`, `soat`, and `pipeline` tool types can call any external API. The right primitive already exists — we just need a way to **route** an unsupported content type to a converter tool during ingestion.

## Solution Overview

Introduce a new **Ingestion Rules** module: a per-project routing table mapping a `content_type` glob to a **converter tool**. When ingestion encounters a content type it cannot extract natively, it looks up the best-matching rule and invokes the tool, which calls whatever external API the user configured (OCR, ASR, vision LLM, …). The tool returns extracted text — either synchronously or, for long-running jobs, via an async callback — and the existing chunk + embed pipeline takes over unchanged.

The converter is a **tool or an agent**. Ingestion Rules only decide *which* converter runs for *which* content type, whether to skip native extraction, how the file is delivered, and how the result is chunked.

```
POST /documents/ingest (fl_… , content_type)
        │
        ▼
extractSourcePages(file)
  ├─ native type (pdf/text/markdown)
  │     ├─ matching rule w/ native_extraction=skip ─► invokeConverter (bypass native) ↓
  │     ├─ text extracted ─────────────────────────► pages → chunk + embed → ready
  │     └─ zero text (e.g. scanned PDF) ───────────► fall back to matching rule ↓
  └─ non-native type ──────────────────────────────► matching rule ↓
        ├─ matching IngestionRule ─────────────► invokeConverter(rule, file)
        │     ├─ tool/agent → "text" | { pages:[…] } (sync) ─► chunk + embed → ready
        │     └─ tool → { status: "pending" }  (async)  ─► doc stays `processing`
        │                                                   └─ external service calls
        │                                                      POST /documents/:id/ingestion-callback
        │                                                      → chunk + embed → ready
        └─ no matching rule
              ├─ native type, empty ───────────► FILE_PARSE_FAILED  (unchanged)
              └─ non-native type ──────────────► UNSUPPORTED_FILE_TYPE (unchanged)
```

**Scanned PDFs** are handled by the same mechanism: the native `unpdf` extractor runs first, and only when it returns no text does ingestion fall back to a rule matching `application/pdf`. That rule's converter — an OCR **tool** or a vision **agent** — produces the text. A born-digital PDF with a text layer never invokes the converter, so there is no added cost for the common case.

## Key Design Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | How the file reaches the converter | **Both** `base64` (default, small files) and `download_url` (large files), selected per rule via `file_delivery` | base64 is provider-agnostic and works for any storage backend; a short-lived signed download URL avoids loading large audio into memory. |
| 2 | How a file is matched to a rule | **Content-type glob, most-specific wins** (`image/png` > `image/*` > `*/*`). Rules are consulted for non-native types, and as a fallback when native extraction yields no text (scanned PDFs). No match → unchanged behavior (`UNSUPPORTED_FILE_TYPE` for non-native types, `FILE_PARSE_FAILED` for empty native extraction). | MIME-based routing is consistent with the existing `extractSourcePages` branch; specificity ordering avoids ambiguity; the empty-native fallback fixes scanned PDFs without a separate code path. |
| 3 | Long-running conversions | **Async callback path built now.** Converter may return `{ status: "pending" }`; result is posted back to a callback endpoint. | Speech-to-text on long audio exceeds the 5-minute stall timeout; a callback decouples SOAT from holding the request open. |
| 4 | Converter output contract | **Accept both** a plain string (wrapped as one page) and `{ pages: [{ text, page_number }] }`. | OCR naturally produces pages; transcription produces flat text. Supporting both avoids forcing transcription tools to fabricate page numbers. |
| 5 | Chunking config on a rule | A rule **may** carry default `chunk_strategy` / `chunk_size` / `chunk_overlap`, overridable per ingest request. | Images suit `whole`; audio may suit `size`. Defaults keep callers from repeating chunk config on every ingest. |
| 6 | Converter is a tool **or** an agent | A rule references exactly one of `tool_id` / `agent_id`. Agent converters send the file as multimodal input to `createGeneration`; the agent's text output becomes the document content. | A vision agent handles images and scanned PDFs with zero extra infra (no adapter). Tools remain best for audio, specialized OCR APIs, and long async jobs (the agent path is awaited inline, no callback). |

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| `IngestionRule` model | ✅ Implemented | `packages/postgresdb/src/models/IngestionRule.ts`. Schema is sync-based in this repo (no migration files) — the table is created via `sequelize.sync()`. |
| `ingestionRules.ts` lib (CRUD + `resolveIngestionRule`) | ✅ Implemented | `packages/server/src/lib/ingestionRules.ts` |
| `validateIngestionRule` | ✅ Implemented | Extracted to `packages/server/src/lib/ingestionRuleValidation.ts` (pure function, no DB — reusable by the REST route and formation module) |
| Content-type glob matching + specificity ranking | ✅ Implemented | Extracted to `packages/server/src/lib/ingestionRuleMatching.ts` |
| `POST/GET/PATCH/DELETE /api/v1/ingestion-rules` | ✅ Implemented | `packages/server/src/rest/v1/ingestionRules.ts` |
| Converter invocation (sync, base64 + download_url) | ✅ Implemented | `invokeConverter()` in `converterInvocation.ts` — tool (`callTool`) or agent (`createGeneration`) |
| `POST /api/v1/documents/:id/ingestion-callback` | ❌ Planned | Token-authed async result callback (Phase 5) |
| Short-lived file download token util | ✅ Implemented | `fileDownloadToken.ts`, for `file_delivery: download_url` |
| OpenAPI (`ingestion-rules.yaml`) | ✅ Implemented | SDK + CLI regenerated |
| Permissions (`ingestion-rules.json`) | ✅ Implemented | Permissions page regenerated |
| Formation module (`ingestionRulesFormationModule.ts` + `formations.yaml`) | ❌ Planned | Phase 6 — provision rules as code |
| Module docs (`modules/ingestion-rules.md` + `documents.md` update) | ✅ Implemented | |
| Tests (REST + documents ingest + mcp) | ✅ Implemented | End-to-end smoke steps for the converter flow added |

## Implementation Phases

Each phase follows red/green TDD per `.claude/rules/quality-assurance.md` and is complete only when `pnpm typecheck`, `pnpm eslint --fix`, `pnpm test`, and `pnpm run -w smoke-tests` all pass.

### Phase 1 — `IngestionRule` resource (data + lib) ✅ Complete

**Deliverables (as implemented):**

- `IngestionRule` Sequelize model (`packages/postgresdb/src/models/IngestionRule.ts`) — `igr_` public ID prefix, `project_id + content_type_glob` unique index, `tool_id`/`agent_id` nullable FKs (`RESTRICT` on delete, like `Document.fileId`), model-level `beforeValidate` guard backstopping the exactly-one-of-`toolId`/`agentId` rule
- `ingestionRules.ts` lib: `createIngestionRule`, `getIngestionRule`, `listIngestionRules`, `updateIngestionRule`, `deleteIngestionRule`
- `resolveIngestionRule({ projectId, contentType })` — most-specific match, backed by `ingestionRuleMatching.ts` (`matchesContentTypeGlob`, `compareGlobSpecificity`)
- `validateIngestionRule({ toolId, agentId, toolType, action, contentTypeGlob, presetParameters })` in `ingestionRuleValidation.ts` — **shared business rule** (per `.claude/rules/modules.md`), pure and DB-free so it is reusable by the REST route (Phase 2) and the formation module (Phase 6). Enforces exactly-one-of `tool_id`/`agent_id`, rejects `client` tools, malformed globs, soat/mcp tools missing an `action`, and `preset_parameters` containing the reserved keys `file` or `callback` (which ingestion injects — see [Tool input](#tool-input-built-by-ingestion-passed-to-calltool)).
- New error code: `INGESTION_RULE_VALIDATION_FAILED` (400). Glob-uniqueness conflicts surface as `INGESTION_RULE_GLOB_CONFLICT` (409). **Referenced-converter existence** is checked at the DB-aware create/update layer (Phase 2), not in `validateIngestionRule` (which is pure and cannot look up a row): a missing `tool_id` raises `TOOL_NOT_FOUND` (new, 400) and a missing `agent_id` raises `AGENT_NOT_FOUND` (existing, 400).
- Lib unit tests (`packages/server/tests/unit/tests/lib/ingestionRules.test.ts`, `ingestionRuleMatching.test.ts`): CRUD, glob specificity ordering, validation failures — 44 tests

*(Design deviation: `validateIngestionRule` and the glob-matching helpers were factored into their own files, `ingestionRuleValidation.ts` and `ingestionRuleMatching.ts`, rather than living inline in `ingestionRules.ts` — keeps each file focused and under the project's `max-lines` lint limit, and lets Phase 2/6 import just the pure validator without pulling in DB-dependent CRUD code.)*

### Phase 2 — REST module + generated clients ✅ Complete

**Deliverables:**

- `rest/v1/ingestionRules.ts` with `@openapi` JSDoc blocks; mounted in `rest/v1/index.ts`
- `openapi/v1/ingestion-rules.yaml`
- `permissions/ingestion-rules.json` → regenerate permissions page
- `pnpm --filter @soat/sdk generate` + `pnpm --filter @soat/cli generate`
- REST tests: CRUD happy path, `401`, `403`, validation (`400`), most-specific resolution, `404`
- `mcp.test.ts`: ingestion-rules tools appear and round-trip

### Phase 3 — Synchronous converter path (base64 delivery) ✅ Complete

**Deliverables:**

- `invokeConverter()` in `documentIngestion.ts`: for a tool rule, build tool input with `data_base64` and call `callTool`; for an agent rule, call `createGeneration` with the file as multimodal input. Interpret output (string | `{ pages }`).
- `extractSourcePages` calls `resolveIngestionRule` for non-native content types, as a PDF fallback when native extraction returns zero pages (scanned PDFs), **and** before native extraction when the matching rule sets `native_extraction: skip` (bypass native, convert every PDF)
- New failure reasons: `CONVERTER_FAILED`, `CONVERTER_OUTPUT_INVALID`
- Rule-level chunk defaults applied, overridable per request (Decision #5)
- Tests: image ingest via matching tool rule → `ready`; scanned-PDF fallback to an `application/pdf` tool rule → `ready`; scanned-PDF fallback to an `application/pdf` **agent** rule → `ready`; `native_extraction: skip` converts a text-layer PDF (native bypassed); `native_extraction: first` leaves a text-layer PDF on the native path (converter not called); non-native type with no rule → `UNSUPPORTED_FILE_TYPE`; empty native extraction with no rule → `FILE_PARSE_FAILED`; converter error → `failed` `CONVERTER_FAILED`; bad output → `failed` `CONVERTER_OUTPUT_INVALID`. `callTool` / `createGeneration` mocked via `jest.spyOn` (both are transitively loaded by `app.ts` — see `.claude/rules/tests.md`).

### Phase 4 — `download_url` delivery ✅ Complete

**Deliverables:**

- Short-lived, signed, single-purpose file-download token (scoped to `GET /files/:id/download`) — reuses existing JWT signing
- `file_delivery: download_url` builds `file.download_url` instead of `data_base64`
- Tests: token issuance, expiry, scope enforcement; converter receives a working URL

### Phase 5 — Async callback path

**Deliverables:**

- Converter returning `{ status: "pending" }` leaves the document `processing` and persists `metadata.conversion = { converter_id, attempt_id, submitted_at }`. `attempt_id` is a fresh identifier per ingestion attempt (a new one is minted on every `POST /documents/:id/ingest`) and is the same value carried in the callback token — so a stale callback from a previous attempt is distinguishable from the current one.
- `POST /api/v1/documents/:id/ingestion-callback` — **token-authed** (single-use signed JWT scoped to `{ documentId, attemptId, purpose: "ingestion-callback" }`), accepts the same output contract, then runs the chunk + embed tail and marks `ready`
- `CONVERSION_STALL_TIMEOUT_MS` (separate, longer than `INGESTION_STALL_TIMEOUT_MS`) so a document awaiting a converter is not prematurely failed; timeout → `failed` `CONVERSION_TIMEOUT`
- **State-machine guards (single-writer via compare-and-set).** Both the callback handler and the timeout sweeper finish a conversion by an atomic conditional update — `UPDATE … WHERE status = 'processing' AND metadata.conversion.attempt_id = :attemptId` — so exactly one of them wins and the loser is a no-op:
  - The callback is accepted only if the document is still `processing` **and** the token's `attemptId` matches the persisted `attempt_id`. This rejects (a) replays, (b) a late callback after the sweeper already failed the doc, and (c) a callback from a superseded attempt after re-ingest.
  - The timeout sweeper transitions `processing → failed (CONVERSION_TIMEOUT)` under the same guard, so it cannot clobber a conversion that a callback has already completed. A callback that loses the race (doc no longer `processing`) is rejected with a clear `409`, never silently dropped.
- Tests: async pending → callback → `ready`; replayed callback rejected; callback for a superseded attempt (after re-ingest) rejected; late callback after timeout rejected (and vice-versa: callback wins, sweeper no-ops); stale conversion → `CONVERSION_TIMEOUT`

### Phase 6 — Formations + smoke + docs polish (smoke steps landed early; formations + docs polish remain)

**Deliverables:**

- `IngestionRuleResourceProperties` in `formations.yaml` + `ingestionRulesFormationModule.ts` (reuses `validateIngestionRule`)
- Smoke steps in `tests/smoke-tests.sh` (via `$SOAT_CLI`): create a converter tool (deterministic stub `http` tool), create a rule, ingest a non-native file, poll to `ready`. Add `CONVERSION_STALL_TIMEOUT_MS` to `tests/docker-compose.smoke.yml`.
- Module docs finalized

## Data Model

### IngestionRule

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Public identifier prefixed with `igr_` |
| `project_id` | string | Owning project |
| `content_type_glob` | string | Glob matched against a file's `content_type` (e.g. `image/*`, `audio/mpeg`, `application/pdf`) |
| `tool_id` | string \| null | Converter tool (`tol_…`); must be a server-callable type (`http`, `mcp`, `soat`, `pipeline`). Mutually exclusive with `agent_id`. |
| `agent_id` | string \| null | Converter agent (`agt_…`). The file is sent to the agent as multimodal input and its text output becomes the document content. Mutually exclusive with `tool_id`. |
| `action` | string \| null | Operation id for `soat`/`mcp` tool converters |
| `preset_parameters` | object \| null | Merged into the tool input before invocation (tool converters only). May not contain the reserved keys `file` or `callback` — ingestion injects those and rejects a rule whose preset would collide with them. |
| `native_extraction` | string | For a native type (PDF, `text/plain`, `text/markdown`): `first` (default) — run the native extractor first, convert only when it yields no text; or `skip` — bypass the native extractor and always convert. On non-native types (images, audio) there is no native extractor, so the converter always runs regardless of this value. |
| `file_delivery` | string | `base64` (default — loads the file into the request body/memory; best for small files) or `download_url` (a short-lived signed URL the provider fetches; use for large audio/images) |
| `chunk_strategy` | string \| null | Optional default (`page`/`whole`/`size`), overridable per ingest request |
| `chunk_size` | number \| null | Optional default for `size` strategy |
| `chunk_overlap` | number \| null | Optional default for `size` strategy |
| `metadata` | object \| null | Arbitrary JSON |
| `created_at` | string | ISO 8601 |
| `updated_at` | string | ISO 8601 |

`project_id + content_type_glob` is unique within a project. Exactly one of `tool_id` / `agent_id` must be set — enforced by `validateIngestionRule` (shared with the formation module).

**Chunk-config precedence.** A `POST /documents/ingest` request overrides the rule's chunk defaults **field by field**: any of `chunk_strategy` / `chunk_size` / `chunk_overlap` present on the request wins; each absent field falls back to the rule, and each field still absent falls back to the ingest defaults (`page` strategy; `chunk_size` 1000 / `chunk_overlap` 200 when `strategy = size`). Setting `chunk_strategy: size` (on either the request or the rule) without a `chunk_size` therefore uses those defaults rather than erroring.

The **PDF fallback** is just a rule with `content_type_glob: application/pdf`. Its `native_extraction` field decides when the converter runs:

- `first` (default) — the native `unpdf` extractor runs first, and the converter fires only when it yields no text. Born-digital PDFs skip the converter; scanned/image-only PDFs go to it. No added cost for the common case.
- `skip` — the native extractor is bypassed and **every** matching PDF goes to the converter. Use when the text layer is unreliable/garbled and you want OCR on all PDFs.

Point either mode at an OCR tool or a vision agent.

### Matching (most-specific wins)

Given a file's `content_type`, `resolveIngestionRule` selects the matching rule with the highest specificity score: an exact type (`image/png`) beats a subtype wildcard (`image/*`) beats a full wildcard (`*/*`). Two rules can never share the *same* glob within a project — a duplicate is rejected at create time with `INGESTION_RULE_GLOB_CONFLICT` (409) — so at resolve time distinct globs always have distinct specificity and there is no ambiguity about which rule wins.

Rules are consulted in two situations:

1. **Non-native content type** — the type has no built-in extractor.
2. **Empty native extraction** — a native type (notably `application/pdf`) produced no text. A rule matching `application/pdf` therefore acts as an OCR fallback for scanned/image-only PDFs, while born-digital PDFs skip the converter entirely.

When no rule matches, behavior is unchanged: a non-native type is rejected with `UNSUPPORTED_FILE_TYPE` (`400`) and an empty native extraction fails the document with `FILE_PARSE_FAILED`.

## Converter Contract

A converter is either a **tool** (JSON contract below) or an **agent**.

**Agent converters.** Instead of the JSON contract, ingestion calls `createGeneration` on the agent with a fixed instruction ("Extract all text / transcribe this file") and the file attached as multimodal input (image/PDF page images for vision models; audio for audio-capable models). The agent's final text output becomes the source text, chunked per the rule's `chunk_strategy`. The generation is awaited inline (bounded by the agent's generation limits) — there is no `{ status: "pending" }` callback for agent converters. The agent's model must support the file's modality; otherwise the document fails with `CONVERTER_FAILED`.

### Building a Tool Converter — No New Server Required

A tool converter does **not** require standing up an external adapter service. A plain `http` tool can already point its `execute.url` directly at a third-party API (e.g. `https://api.openai.com/v1/chat/completions`, `https://api.x.ai/v1/audio/transcriptions`) — `callTool` sends the resolved input as the request body and returns the raw response verbatim, no SOAT endpoint in between.

The reshaping between ingestion's fixed converter contract (below) and a provider's native request/response shape is handled by wrapping that `http` tool in a **`pipeline`** tool, using the existing JSON Logic mapping engine (`json-logic-engine`, already used for pipeline `input`/`output`) — `cat` for string concatenation (e.g. building a `data:` URI), `var` for extracting nested response paths. No new SOAT code, no externally hosted adapter:

```jsonc
// Step tool: a plain http tool pointed straight at the provider
{
  "name": "openai-chat-completions",
  "type": "http",
  "execute": {
    "url": "https://api.openai.com/v1/chat/completions",
    "method": "POST",
    // NOTE: http tools do not resolve credentials from a Secret — this key is
    // stored on the tool and readable by anyone who can read it. Use a scoped,
    // rotatable key and restrict tool access with policies (see Security).
    "headers": { "Authorization": "Bearer <provider-key>" }
  }
}

// Converter tool: a pipeline reshaping in both directions
{
  "name": "openai-vision-ocr",
  "type": "pipeline",
  "pipeline": {
    "steps": [{
      "id": "call_openai",
      "tool_id": "tool_openai_chat",
      "input": {
        "model": "gpt-4o-mini",
        "messages": [{
          "role": "user",
          "content": [
            { "type": "text", "text": "Extract all text from this image." },
            { "type": "image_url", "image_url": { "url": {
              "cat": ["data:", { "var": "input.file.content_type" }, ";base64,", { "var": "input.file.data_base64" }]
            }}}
          ]
        }]
      }
    }],
    "output": {
      "pages": [{ "text": { "var": "steps.call_openai.choices.0.message.content" }, "page_number": 1 }]
    }
  }
}
```

The `IngestionRule.tool_id` then points at the **pipeline** tool (`openai-vision-ocr`), not the raw `http` tool — `resolveConverterToolType` and `validateIngestionRule` already accept `pipeline` as a server-callable type (only `client` is rejected).

The image example above uses `data_base64`, which is fine for small images but loads the whole file into the request body and SOAT's memory — for large images/scanned PDFs, pair the rule with `file_delivery: download_url` and a provider that accepts a URL. Audio is the canonical `download_url` case. A speech-to-text provider whose API takes a JSON body with a remote URL (e.g. [Deepgram](https://developers.deepgram.com/docs/pre-recorded-audio)) maps cleanly onto the contract with no multipart handling:

```jsonc
// Converter tool: pipeline around an http tool pointed at the STT provider
{
  "name": "deepgram-transcribe",
  "type": "pipeline",
  "pipeline": {
    "steps": [{
      "id": "call_stt",
      "tool_id": "tool_deepgram_http",              // http tool → https://api.deepgram.com/v1/listen
      "input": { "url": { "var": "input.file.download_url" } }
    }],
    "output": {
      "pages": [{
        "text": { "var": "steps.call_stt.results.channels.0.alternatives.0.transcript" },
        "page_number": 1
      }]
    }
  }
}
```

For providers whose transcription endpoint expects a **multipart** file upload rather than a JSON URL, either choose a URL-based provider (as above) or add multipart support to the `http` tool — a JSON-Logic mapping alone cannot build a multipart body. This is why the demonstrated audio path uses `download_url` + a URL-accepting API.

### Tool input (built by ingestion, passed to `callTool`)

```jsonc
{
  "file": {
    "id": "fl_01",
    "filename": "scan.png",
    "content_type": "image/png",
    "size": 20480,
    "data_base64": "iVBORw0KGgo…",        // when file_delivery = base64
    "download_url": "https://…/files/fl_01/download?token=…" // when file_delivery = download_url
  },
  "callback": {                            // present so long-running tools can defer
    "url": "https://…/api/v1/documents/doc_01/ingestion-callback",
    "token": "…"                           // single-use, scoped to this document + attempt
  }
  // ...rule.preset_parameters merged in at the top level.
  // `file` and `callback` are reserved and cannot be overridden by a preset
  // (rejected at rule creation), so ingestion-injected fields always win.
}
```

### Output (returned by the tool, or POSTed to the callback)

Accepted shapes (Decision #4):

```jsonc
"All the extracted text"                                  // → one page
{ "pages": [{ "text": "page 1", "page_number": 1 }] }     // → paged
{ "status": "pending" }                                    // → wait for callback
```

Any other shape fails the document with `CONVERTER_OUTPUT_INVALID`.

## REST API

Body fields use `snake_case` per project convention.

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/api/v1/ingestion-rules` | Create a rule |
| GET    | `/api/v1/ingestion-rules` | List rules (project-scoped, policy-filtered) |
| GET    | `/api/v1/ingestion-rules/:id` | Get a rule |
| PATCH  | `/api/v1/ingestion-rules/:id` | Update a rule |
| DELETE | `/api/v1/ingestion-rules/:id` | Delete a rule |
| POST   | `/api/v1/documents/:id/ingestion-callback` | Async converter result (token-authed) |

### Create example

```jsonc
POST /api/v1/ingestion-rules
{
  "project_id": "prj_01",
  "content_type_glob": "image/*",
  "tool_id": "tol_ocr",
  "file_delivery": "base64",
  "chunk_strategy": "whole"
}
```

## Permissions

| Permission | Endpoint |
|------------|----------|
| `ingestion-rules:CreateIngestionRule` | `POST /api/v1/ingestion-rules` |
| `ingestion-rules:ListIngestionRules` | `GET /api/v1/ingestion-rules` |
| `ingestion-rules:GetIngestionRule` | `GET /api/v1/ingestion-rules/:id` |
| `ingestion-rules:UpdateIngestionRule` | `PATCH /api/v1/ingestion-rules/:id` |
| `ingestion-rules:DeleteIngestionRule` | `DELETE /api/v1/ingestion-rules/:id` |

The `ingestion-callback` endpoint is authorized by its single-use token, not an IAM action — the external converter is not a SOAT principal. The token is a signed JWT scoped to one document and one ingestion attempt (`attemptId`), accepted only while that attempt is still `processing` (see the atomic guard in Phase 5).

The caller creating a rule must have read access to the referenced tool or agent; converter invocation at ingest time runs with the ingesting caller's authorization.

## Configuration

| Environment Variable | Required | Description |
|----------------------|----------|-------------|
| `CONVERSION_STALL_TIMEOUT_MS` | No | How long (ms) a document may await an async converter callback before it is auto-failed with `CONVERSION_TIMEOUT`. Separate from (and typically longer than) `INGESTION_STALL_TIMEOUT_MS`. |

## Security

- **Callback token** — signed JWT, single-use, expiring, scoped to `{ documentId, attemptId, purpose: "ingestion-callback" }`. Accepted only while the document is `processing` **and** the token's `attemptId` matches the current attempt, applied as an atomic compare-and-set (see Phase 5). This guards replay, cross-attempt callbacks after re-ingest, and the callback-vs-timeout race — exactly one writer completes a conversion.
- **Download URL** — short-lived signed token scoped to `GET /files/:id/download`, required because the file-download route is normally user-authed and an external API is not a SOAT user.
- **Converter credentials** — an **agent** converter's provider key is stored as an encrypted Secret (referenced by the AI provider's `secret_id`). An **http tool** converter has no secret-reference mechanism today, so its key lives in the tool's `execute.headers` and is readable by anyone with read access to the tool — restrict with policies and use scoped, rotatable keys. (Secret references for tool headers are a candidate follow-up.)
- **Tool type restriction** — `client` tools are rejected at rule creation and at invocation; only `http`/`mcp`/`soat`/`pipeline` tools (or an agent) run server-side.
- **No new outbound surface** — tool converters call external APIs through the existing `callTool` path and its policy checks; agent converters run through the existing `createGeneration` path.

## Out of Scope

- Building OCR/ASR into the server (converters are user-provided tools or agents).
- Retry/backoff policies for failed converters (re-run via `POST /documents/:id/ingest`).
- Multiple converter rules per content type with fallback chaining (uniqueness enforces one rule per glob).
- Multimodal-native ingestion that skips text extraction (documents remain text + embeddings).
