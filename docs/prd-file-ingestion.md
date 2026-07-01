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

The converter is **always a tool**. Ingestion Rules only decide *which* tool runs for *which* content type, plus how the file is delivered to it and how the result is chunked.

```
POST /documents/ingest (fl_… , content_type)
        │
        ▼
extractSourcePages(file)
  ├─ native type (pdf/text/markdown)
  │     ├─ text extracted ─────────────────────► pages → chunk + embed → ready
  │     └─ zero text (e.g. scanned PDF) ───────► fall back to matching rule ↓
  └─ non-native type ──────────────────────────► matching rule ↓
        ├─ matching IngestionRule ─────────────► invokeConverter(rule, file)
        │     ├─ tool → "text" | { pages:[…] }  (sync)  ─► chunk + embed → ready
        │     └─ tool → { status: "pending" }  (async)  ─► doc stays `processing`
        │                                                   └─ external service calls
        │                                                      POST /documents/:id/ingestion-callback
        │                                                      → chunk + embed → ready
        └─ no matching rule
              ├─ native type, empty ───────────► FILE_PARSE_FAILED  (unchanged)
              └─ non-native type ──────────────► UNSUPPORTED_FILE_TYPE (unchanged)
```

**Scanned PDFs** are handled by the same mechanism: the native `unpdf` extractor runs first, and only when it returns no text does ingestion fall back to a rule matching `application/pdf`. That rule's converter tool (an OCR service) produces the text. A born-digital PDF with a text layer never invokes the converter, so there is no added cost for the common case.

## Key Design Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | How the file reaches the converter | **Both** `base64` (default, small files) and `download_url` (large files), selected per rule via `file_delivery` | base64 is provider-agnostic and works for any storage backend; a short-lived signed download URL avoids loading large audio into memory. |
| 2 | How a file is matched to a rule | **Content-type glob, most-specific wins** (`image/png` > `image/*` > `*/*`). Rules are consulted for non-native types, and as a fallback when native extraction yields no text (scanned PDFs). No match → unchanged behavior (`UNSUPPORTED_FILE_TYPE` for non-native types, `FILE_PARSE_FAILED` for empty native extraction). | MIME-based routing is consistent with the existing `extractSourcePages` branch; specificity ordering avoids ambiguity; the empty-native fallback fixes scanned PDFs without a separate code path. |
| 3 | Long-running conversions | **Async callback path built now.** Converter may return `{ status: "pending" }`; result is posted back to a callback endpoint. | Speech-to-text on long audio exceeds the 5-minute stall timeout; a callback decouples SOAT from holding the request open. |
| 4 | Converter output contract | **Accept both** a plain string (wrapped as one page) and `{ pages: [{ text, page_number }] }`. | OCR naturally produces pages; transcription produces flat text. Supporting both avoids forcing transcription tools to fabricate page numbers. |
| 5 | Chunking config on a rule | A rule **may** carry default `chunk_strategy` / `chunk_size` / `chunk_overlap`, overridable per ingest request. | Images suit `whole`; audio may suit `size`. Defaults keep callers from repeating chunk config on every ingest. |

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| `IngestionRule` model + migration | ❌ Planned | New table in `packages/postgresdb` |
| `ingestionRules.ts` lib (CRUD + `resolveIngestionRule` + `validateIngestionRule`) | ❌ Planned | `packages/server/src/lib/ingestionRules.ts` |
| `POST/GET/PATCH/DELETE /api/v1/ingestion-rules` | ❌ Planned | `packages/server/src/rest/v1/ingestionRules.ts` |
| Converter invocation in `extractSourcePages` | ❌ Planned | `invokeConverter()` in `documentIngestion.ts` |
| `POST /api/v1/documents/:id/ingestion-callback` | ❌ Planned | Token-authed async result callback |
| Short-lived file download token util | ❌ Planned | For `file_delivery: download_url` |
| OpenAPI (`ingestion-rules.yaml` + `documents.yaml` updates) | ❌ Planned | Then regenerate SDK + CLI |
| Permissions (`ingestion-rules.json`) | ❌ Planned | Regenerate permissions page |
| Formation module (`ingestionRulesFormationModule.ts` + `formations.yaml`) | ❌ Planned | Phase 6 — provision rules as code |
| Module docs (`modules/ingestion-rules.md` + `documents.md` update) | ❌ Planned | |
| Tests (REST + documents ingest + mcp + smoke) | ❌ Planned | |

## Implementation Phases

Each phase follows red/green TDD per `.claude/rules/quality-assurance.md` and is complete only when `pnpm typecheck`, `pnpm eslint --fix`, `pnpm test`, and `pnpm run -w smoke-tests` all pass.

### Phase 1 — `IngestionRule` resource (data + lib)

**Deliverables:**

- `IngestionRule` Sequelize model + migration (`packages/postgresdb`)
- `ingestionRules.ts` lib: `createIngestionRule`, `getIngestionRule`, `listIngestionRules`, `updateIngestionRule`, `deleteIngestionRule`
- `resolveIngestionRule({ projectId, contentType })` — most-specific match
- `validateIngestionRule({ toolType, action, contentTypeGlob })` — **shared business rule** (per `.claude/rules/modules.md`), reused by the REST route and the formation module. Rejects `client` tools, malformed globs, and soat/mcp tools missing an `action`.
- Lib unit tests: CRUD, glob specificity ordering, validation failures

### Phase 2 — REST module + generated clients

**Deliverables:**

- `rest/v1/ingestionRules.ts` with `@openapi` JSDoc blocks; mounted in `rest/v1/index.ts`
- `openapi/v1/ingestion-rules.yaml`
- `permissions/ingestion-rules.json` → regenerate permissions page
- `pnpm --filter @soat/sdk generate` + `pnpm --filter @soat/cli generate`
- REST tests: CRUD happy path, `401`, `403`, validation (`400`), most-specific resolution, `404`
- `mcp.test.ts`: ingestion-rules tools appear and round-trip

### Phase 3 — Synchronous converter path (base64 delivery)

**Deliverables:**

- `invokeConverter()` in `documentIngestion.ts`: build tool input with `data_base64`, call `callTool`, interpret output (string | `{ pages }`)
- `extractSourcePages` calls `resolveIngestionRule` for non-native content types **and** as a fallback when native extraction returns zero pages (scanned PDFs)
- New failure reasons: `CONVERTER_FAILED`, `CONVERTER_OUTPUT_INVALID`
- Rule-level chunk defaults applied, overridable per request (Decision #5)
- Tests: image ingest via matching rule → `ready`; scanned-PDF fallback to an `application/pdf` rule → `ready`; non-native type with no rule → `UNSUPPORTED_FILE_TYPE`; empty native extraction with no rule → `FILE_PARSE_FAILED`; converter error → `failed` `CONVERTER_FAILED`; bad output → `failed` `CONVERTER_OUTPUT_INVALID`. `callTool` mocked via `jest.spyOn` (it is transitively loaded by `app.ts` — see `.claude/rules/tests.md`).

### Phase 4 — `download_url` delivery

**Deliverables:**

- Short-lived, signed, single-purpose file-download token (scoped to `GET /files/:id/download`) — reuses existing JWT signing
- `file_delivery: download_url` builds `file.download_url` instead of `data_base64`
- Tests: token issuance, expiry, scope enforcement; converter receives a working URL

### Phase 5 — Async callback path

**Deliverables:**

- Converter returning `{ status: "pending" }` leaves the document `processing` and persists `metadata.conversion = { tool_id, callback_token_id, submitted_at }`
- `POST /api/v1/documents/:id/ingestion-callback` — **token-authed** (single-use signed JWT scoped to `{ documentId, attemptId, purpose: "ingestion-callback" }`), accepts the same output contract, then runs the chunk + embed tail and marks `ready`
- `CONVERSION_STALL_TIMEOUT_MS` (separate, longer than `INGESTION_STALL_TIMEOUT_MS`) so a document awaiting a converter is not prematurely failed; timeout → `failed` `CONVERSION_TIMEOUT`
- State-machine guards: reject callback once the document has left `processing` (prevents replay and sync+callback double-completion)
- Tests: async pending → callback → `ready`; replayed callback rejected; stale conversion → `CONVERSION_TIMEOUT`

### Phase 6 — Formations + smoke + docs polish

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
| `content_type_glob` | string | Glob matched against a file's `content_type` (e.g. `image/*`, `audio/mpeg`) |
| `tool_id` | string | Converter tool (`tol_…`); must be a server-callable type (`http`, `mcp`, `soat`, `pipeline`) |
| `action` | string \| null | Operation id for `soat`/`mcp` tools |
| `preset_parameters` | object \| null | Merged into the tool input before invocation |
| `file_delivery` | string | `base64` (default) or `download_url` |
| `chunk_strategy` | string \| null | Optional default (`page`/`whole`/`size`), overridable per ingest request |
| `chunk_size` | number \| null | Optional default for `size` strategy |
| `chunk_overlap` | number \| null | Optional default for `size` strategy |
| `metadata` | object \| null | Arbitrary JSON |
| `created_at` | string | ISO 8601 |
| `updated_at` | string | ISO 8601 |

`project_id + content_type_glob` is unique within a project.

### Matching (most-specific wins)

Given a file's `content_type`, `resolveIngestionRule` selects the matching rule with the highest specificity score: an exact type (`image/png`) beats a subtype wildcard (`image/*`) beats a full wildcard (`*/*`). Ties are impossible because of the uniqueness constraint.

Rules are consulted in two situations:

1. **Non-native content type** — the type has no built-in extractor.
2. **Empty native extraction** — a native type (notably `application/pdf`) produced no text. A rule matching `application/pdf` therefore acts as an OCR fallback for scanned/image-only PDFs, while born-digital PDFs skip the converter entirely.

When no rule matches, behavior is unchanged: a non-native type is rejected with `UNSUPPORTED_FILE_TYPE` (`400`) and an empty native extraction fails the document with `FILE_PARSE_FAILED`.

## Converter Tool Contract

### Input (built by ingestion, passed to `callTool`)

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
  // ...rule.preset_parameters merged in at the top level
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

The `ingestion-callback` endpoint is authorized by its single-use token, not an IAM action — the external converter is not a SOAT principal. The token is a signed JWT scoped to one document and one ingestion attempt, rejected once the document leaves `processing`.

The caller creating a rule must have read access to the referenced tool; converter invocation at ingest time runs with the ingesting caller's authorization.

## Configuration

| Environment Variable | Required | Description |
|----------------------|----------|-------------|
| `CONVERSION_STALL_TIMEOUT_MS` | No | How long (ms) a document may await an async converter callback before it is auto-failed with `CONVERSION_TIMEOUT`. Separate from (and typically longer than) `INGESTION_STALL_TIMEOUT_MS`. |

## Security

- **Callback token** — signed JWT, single-use, expiring, scoped to `{ documentId, attemptId, purpose: "ingestion-callback" }`; rejected once the document is no longer `processing`. Guards replay and sync+callback double-completion.
- **Download URL** — short-lived signed token scoped to `GET /files/:id/download`, required because the file-download route is normally user-authed and an external API is not a SOAT user.
- **Tool type restriction** — `client` tools are rejected at rule creation and at invocation; only `http`/`mcp`/`soat`/`pipeline` run server-side.
- **No new outbound surface** — converters call external APIs through the existing `callTool` path and its policy checks.

## Out of Scope

- Building OCR/ASR into the server (converters are user-provided tools).
- Retry/backoff policies for failed converters (re-run via `POST /documents/:id/ingest`).
- Multiple converter rules per content type with fallback chaining (uniqueness enforces one rule per glob).
- Multimodal-native ingestion that skips text extraction (documents remain text + embeddings).
