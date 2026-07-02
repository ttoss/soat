import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingestion Rules

An Ingestion Rule routes a file `content_type` to a converter [Tool](./tools.md) so that non-text files (images, audio, scanned PDFs) can be ingested into [Documents](./documents.md).

## Overview

Native [file ingestion](./documents.md#file-ingestion-and-chunking) only extracts text from PDFs (text layer), `text/plain`, and `text/markdown`. Anything else fails with `FILE_PARSE_FAILED`. An Ingestion Rule fills that gap: it maps a `content_type` glob (e.g. `image/*`, `audio/mpeg`, `application/pdf`) to a **converter** — either a [Tool](./tools.md) (`http`/`mcp`/`soat`/`pipeline`) that calls an external OCR, speech-to-text, or vision service, or an [Agent](./agents.md) with a multimodal model. When `POST /documents/ingest` receives a file whose type has no native extractor — or a PDF whose native extraction yields no text — it looks up the best-matching rule and invokes the converter to produce the document text; the existing chunk + embedding pipeline is unchanged.

Rules are per-project. SOAT does not perform OCR or transcription itself — the rule points at a tool or agent you configure, so you can use any API or model you like.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Ingest Images and Audio with Converters - Step 6 (Route images to the agent)](/docs/tutorials/ingest-images-and-audio#step-6--route-images-to-the-agent)
- [Ingest Images and Audio with Converters - Step 11 (Route audio to the transcription agent)](/docs/tutorials/ingest-images-and-audio#step-11--route-audio-to-the-transcription-agent)

## Data Model

### IngestionRule

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Public identifier prefixed with `igr_` |
| `project_id` | string | ID of the owning project |
| `content_type_glob` | string | Glob matched against the file's `content_type` (`image/*`, `image/png`, `audio/mpeg`, `application/pdf`) |
| `tool_id` | string \| null | Converter tool (`tol_…`). Must be a server-callable type: `http`, `mcp`, `soat`, or `pipeline`. `client` tools are rejected. Mutually exclusive with `agent_id`. |
| `agent_id` | string \| null | Converter agent (`agt_…`). The file is sent to the agent as multimodal input and its text output becomes the document content. Mutually exclusive with `tool_id`. |
| `action` | string \| null | Operation id, required for `soat`/`mcp` tool converters |
| `preset_parameters` | object \| null | Merged into the tool input before invocation (tool converters only). Cannot contain the reserved keys `file` or `callback`, which ingestion injects. |
| `native_extraction` | string | For PDFs: `first` (default) converts only when native extraction yields no text; `skip` bypasses native extraction and converts every matching PDF. Ignored for non-native types. |
| `file_delivery` | string | How the file reaches a tool converter: `base64` (default) or `download_url` |
| `chunk_strategy` | string \| null | Optional default chunk strategy (`page`/`whole`/`size`), overridable per ingest request |
| `chunk_size` | number \| null | Optional default for the `size` strategy |
| `chunk_overlap` | number \| null | Optional default for the `size` strategy |
| `metadata` | object \| null | Arbitrary JSON metadata |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last-updated timestamp |

`project_id + content_type_glob` is unique within a project — one rule per glob. Exactly one of `tool_id` / `agent_id` must be set.

## Key Concepts

### Content-Type Matching

At ingest time, `resolveIngestionRule` picks the matching rule with the highest specificity: an exact type (`image/png`) beats a subtype wildcard (`image/*`), which beats a full wildcard (`*/*`).

Rules are consulted in two cases:

1. **Non-native content type** — the file type has no [built-in extractor](./documents.md#file-ingestion-and-chunking).
2. **Empty native extraction** — a native type produced no text. In particular, a rule matching `application/pdf` acts as an **OCR fallback for scanned/image-only PDFs**: the built-in `unpdf` extractor runs first, and only when it returns no text does ingestion invoke the converter. Born-digital PDFs with a text layer skip the converter, so there is no added cost for the common case.

When no rule matches, behavior is unchanged: a non-native type is rejected with `UNSUPPORTED_FILE_TYPE` (`400`), and an empty native extraction fails the document with `FILE_PARSE_FAILED`.

### PDF Conversion Mode

For PDFs, the `native_extraction` field on the matching `application/pdf` rule controls when the converter runs:

| `native_extraction` | Behavior | Use when |
|---------------------|----------|----------|
| `first` (default) | Native `unpdf` extraction runs first; the converter fires only for PDFs with no text layer. | You only want to OCR scanned/image-only PDFs; born-digital PDFs stay on the fast native path. |
| `skip` | Native extraction is bypassed; **every** matching PDF goes to the converter. | The PDFs' text layer is unreliable or garbled and you want OCR applied to all of them. |

`native_extraction` has no effect on non-native types (images, audio) — there is no native extractor to skip, so their converter always runs.

### Converter: Tool or Agent

A rule's converter is either a [Tool](./tools.md) or an [Agent](./agents.md) (exactly one):

- **Tool converter** (`tool_id`) — ingestion calls the tool with the JSON contract below and reads text from its response. Best for audio, specialized OCR APIs, and long async jobs (the tool can defer via the callback).
- **Agent converter** (`agent_id`) — ingestion sends the file to the agent as multimodal input with a fixed "extract all text / transcribe" instruction; the agent's text output becomes the document content. Zero extra infrastructure, but the agent's model must support the file's modality (a **vision** model for images and scanned PDFs; an **audio-capable** model for audio). The generation is awaited inline — there is no deferral/callback for agent converters.

:::caution Audio agent converters need a Chat Completions-compatible AI provider
An agent whose [AI provider](./ai-providers.md) uses the `openai` provider slug talks to OpenAI's Responses API, which does not accept audio input — an audio file routed to such an agent fails with `CONVERTER_FAILED` (`AI_UnsupportedFunctionalityError: file part media type audio/...`). To use an OpenAI audio-capable model (e.g. `gpt-audio-mini`) as an audio converter today, register it with the **`custom`** provider slug and `base_url` pointed at `https://api.openai.com/v1` instead — that path uses the Chat Completions API, which does support audio input. Vision (image) agent converters are unaffected. See [Ingest Images and Audio with Converters](/docs/tutorials/ingest-images-and-audio) for a worked example.
:::

### Building a Tool Converter for a Third-Party API

A tool converter does not require hosting a separate adapter service. An [`http` tool](./tools.md#http) can point its `execute.url` directly at a third-party API (OpenAI, xAI, …); a [`pipeline` tool](./tools.md#pipeline) wrapping it reshapes the request and response using the same [JSON Logic](https://jsonlogic.com) mapping every other pipeline step uses — `cat` to build values like a base64 `data:` URI, `var` to extract a nested response field into the shape below. Point `IngestionRule.tool_id` at the pipeline tool. See [Tools — pipeline](./tools.md#pipeline) for the mapping syntax.

Since the [Converter Tool Contract](#converter-tool-contract) accepts a bare string as its simplest output shape, the wrapping pipeline's `output` can be a single `var` expression rather than an object — it resolves directly to that scalar:

```jsonc
{
  "steps": [
    {
      "id": "call",
      "tool_id": "tol_stt_http",
      "input": { "file": { "var": "input.file" } }
    }
  ],
  "output": { "var": "steps.call.text" } // resolves to a bare string, e.g. "All the extracted text"
}
```

Hold the third-party API key in a [Secret](./secrets.md) and embed a [secret reference](./secrets.md#secret-references-secret) in the `http` tool's `execute.headers` — e.g. `{"Authorization": "Bearer {{secret:sec_01HXYZ}}"}`. Never paste the raw key into the tool config: the config is echoed back by `GET /tools/{id}`, while the `{{secret:...}}` token resolves only at call time and the raw value is never returned by any API response.

Not every third-party API accepts JSON. Many audio (speech-to-text) and specialized OCR endpoints require `multipart/form-data` and reject a JSON body outright (e.g. xAI's `POST /v1/stt`). For those, set [`execute.body_mode: "multipart"`](./tools.md#request-body-encoding-body_mode) on the `http` tool: pass the file through as the `{ content_type, filename, data_base64 }` shape ingestion already provides and it is decoded and attached as a real file part, alongside any scalar fields (model name, language, …). This keeps the "no separate adapter service" property — the `http` tool calls the multipart API directly.

### Converter Tool Contract

A **tool** converter is called via the same server-side path as any other tool call, with a fixed input shape, and must return one of three output shapes.

**Input** built by ingestion:

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
  "callback": {                            // lets long-running tools defer their result
    "url": "https://…/api/v1/documents/doc_01/ingestion-callback",
    "token": "…"
  }
  // preset_parameters are merged in at the top level
}
```

**Output** — the tool may return either extracted text or a deferral:

```jsonc
"All the extracted text"                              // wrapped as a single page
{ "pages": [{ "text": "page 1", "page_number": 1 }] } // paged (e.g. OCR per page)
{ "status": "pending" }                                // long-running deferral — see below
```

Any other shape fails the document with `CONVERTER_OUTPUT_INVALID`; a tool error fails it with `CONVERTER_FAILED`. `{ "status": "pending" }` is only honored for a tool converter ingested in the default **async** mode (see [Synchronous vs Async (Callback) Conversion](#synchronous-vs-async-callback-conversion)) — an agent converter, or a synchronous ingest request (`?async=false`), fails with `CONVERTER_FAILED` instead, since neither can wait for a later callback.

### File Delivery

`file_delivery` controls how the file bytes reach the tool's external API:

| Mode | Behavior | Use when |
|------|----------|----------|
| `base64` (default) | Ingestion downloads the file and passes `data_base64` in the tool input | Small files; provider-agnostic; works with any storage backend. Note: the whole file is loaded into memory and the request body. |
| `download_url` | Ingestion passes a short-lived signed `download_url`; the tool/API fetches it | Large files (long audio, high-resolution images/scans) where base64 is impractical, and providers that accept a remote URL |

### Synchronous vs Async (Callback) Conversion

A converter tool that returns text (or `{ pages }`) directly is **synchronous** — ingestion continues to chunk and embed inline. An agent converter is always synchronous: its generation is awaited inline and it has no deferral path.

A tool that returns `{ status: "pending" }` is **asynchronous** — but only when the document is being ingested in the default async mode (`POST /documents/ingest` without `?async=false`). The document stays in `processing` while the external job runs, then the tool (or the service it wires) posts the result to:

```
POST /api/v1/documents/{document_id}/ingestion-callback?token={token}
{ "text": "..." }                                      // or { "pages": [...] }
```

`{document_id}` and `token` come from the `callback` block ingestion injected into the tool's input (see [Converter Tool Contract](#converter-tool-contract)); the request body uses the same output contract as a synchronous converter, adapted for a JSON body (a single page is `{ "text": "..." }` rather than a bare string, since a top-level JSON string is not a valid HTTP JSON body).

The callback is authorized by a single-use, signed token scoped to that document and ingestion attempt — not by an IAM action, since the external converter is not a SOAT user. It is accepted (`204`) only while that attempt is still `processing`; a replayed callback, a callback for a superseded attempt (after re-ingest), or one that arrives after the stall timeout already failed the document is rejected with `409 INGESTION_CALLBACK_CONFLICT`. An invalid or mismatched token is rejected with `401 INGESTION_CALLBACK_INVALID_TOKEN`. Once a valid result arrives, ingestion runs the normal chunk + embed tail and marks the document `ready`.

If a synchronous ingest request (`?async=false`) or an agent converter encounters `{ status: "pending" }`, the document fails immediately with `CONVERTER_FAILED` — neither can wait for a callback that may arrive arbitrarily later. Design a tool that might defer to only do so under async ingestion.

A document awaiting a callback for longer than `CONVERSION_STALL_TIMEOUT_MS` is auto-failed with `CONVERSION_TIMEOUT` (see [Configuration](#configuration)). This is the converter-specific counterpart of the [stuck-ingestion recovery](./documents.md#stuck-ingestion-recovery) in the documents module — both use the same lazy "recover on next read" mechanism (checked whenever the document is fetched, not a background cron), but the callback path additionally guards against a callback racing the timeout sweeper: the two finish a conversion via an atomic compare-and-set that only one can win, so a legitimate callback that arrives just as the sweeper fires is never silently dropped — it either wins outright or, if the sweeper already won, is rejected with a clear `409` rather than corrupting the failed state.

### Failure Reasons

Converter-related `failure_reason` values that can appear on a failed document (alongside the existing `FILE_PARSE_FAILED`, `INGESTION_TIMEOUT`):

| `failure_reason` | Meaning |
|------------------|---------|
| `CONVERTER_FAILED` | The converter tool/agent call errored, an agent converter returned an async deferral (unsupported), or a tool converter returned an async deferral during synchronous ingestion (`?async=false`) |
| `CONVERTER_OUTPUT_INVALID` | The tool (or callback) returned an unrecognized output shape |
| `CONVERSION_TIMEOUT` | An async conversion did not call back within `CONVERSION_STALL_TIMEOUT_MS` |

## Configuration

| Environment Variable | Required | Description |
|----------------------|----------|-------------|
| `CONVERSION_STALL_TIMEOUT_MS` | No | How long (ms) a document may await an async converter callback before being auto-failed with `CONVERSION_TIMEOUT`. Defaults to 30 minutes. Separate from, and typically longer than, `INGESTION_STALL_TIMEOUT_MS` (default 5 minutes). |

## Examples

### Create an ingestion rule

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id proj_ABC \
  --content-type-glob "image/*" \
  --tool-id tol_ocr \
  --file-delivery base64 \
  --chunk-strategy whole
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.ingestionRules.createIngestionRule({
  body: {
    project_id: 'proj_ABC',
    content_type_glob: 'image/*',
    tool_id: 'tol_ocr',
    file_delivery: 'base64',
    chunk_strategy: 'whole',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/ingestion-rules \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "content_type_glob": "image/*",
    "tool_id": "tol_ocr",
    "file_delivery": "base64",
    "chunk_strategy": "whole"
  }'
```

</TabItem>
</Tabs>

### OCR fallback for scanned PDFs (agent converter)

A rule matching `application/pdf` fires only when the native extractor returns no text (a scanned PDF). Point it at a vision **agent** — no external adapter needed. Born-digital PDFs skip it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-ingestion-rule \
  --project-id proj_ABC \
  --content-type-glob "application/pdf" \
  --agent-id agt_vision \
  --chunk-strategy whole
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await soat.ingestionRules.createIngestionRule({
  body: {
    project_id: 'proj_ABC',
    content_type_glob: 'application/pdf',
    agent_id: 'agt_vision',
    chunk_strategy: 'whole',
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/ingestion-rules \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "content_type_glob": "application/pdf",
    "agent_id": "agt_vision",
    "chunk_strategy": "whole"
  }'
```

</TabItem>
</Tabs>

### Ingest an image using the rule

Once a matching rule exists, ingest a non-native file exactly like any other — ingestion routes it to the converter automatically.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Upload the image, then ingest — the image/* rule handles conversion
FILE_ID=$(soat upload-file --project-id proj_ABC --file ./scan.png | jq -r '.id')

soat ingest-document \
  --project-id proj_ABC \
  --file-id "$FILE_ID" \
  --path-prefix /scans/
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

const { data, error } = await soat.documents.ingestDocument({
  body: { project_id: 'proj_ABC', file_id: fileId, path_prefix: '/scans/' },
});
if (error) throw new Error(JSON.stringify(error));

// Poll until ready — async converters keep the document in `processing`
let doc = data;
while (doc.status === 'pending' || doc.status === 'processing') {
  await new Promise((r) => setTimeout(r, 500));
  const { data: polled } = await soat.documents.getDocument({
    path: { document_id: doc.id },
  });
  doc = polled!;
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/documents/ingest \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"proj_ABC\",
    \"file_id\": \"$FILE_ID\",
    \"path_prefix\": \"/scans/\"
  }"
```

</TabItem>
</Tabs>

### List rules

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-ingestion-rules --project-id proj_ABC
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.ingestionRules.listIngestionRules({
  params: { query: { project_id: 'proj_ABC' } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl https://api.example.com/api/v1/ingestion-rules?project_id=proj_ABC \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>
