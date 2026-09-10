---
description: "Route a file content_type to a converter tool so images, audio, and scanned PDFs can be ingested into searchable documents."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingestion Rules

An Ingestion Rule routes a file `content_type` to a converter [Tool](./tools.md) so that non-text files (images, audio, scanned PDFs) can be ingested into [Documents](./documents.md).

## Overview

Native [file ingestion](./documents.md#file-ingestion-and-chunking) extracts text only from PDFs (text layer), `text/plain`, and `text/markdown`; anything else fails with `FILE_PARSE_FAILED`. An Ingestion Rule maps a `content_type` glob (`image/*`, `audio/mpeg`, `application/pdf`) to a **converter**: a [Tool](./tools.md) (`http`/`mcp`/`builtin`/`pipeline`) calling an external OCR, speech-to-text or vision service, or an [Agent](./agents.md) with a multimodal model. When [`POST /documents/ingest`](/docs/api/documents/ingest-document) receives a file with no native extractor, or a PDF whose native extraction yields no text, the best-matching rule's converter produces the document text; chunking and embedding are unchanged.

Rules are per-project. SOAT performs no OCR or transcription itself. In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md), the [converter contract](#converter-tool-contract) is the knowledge engine's bring-your-own-algorithm seam.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Ingest Images and Audio with Converters - Step 6 (Route images to the agent)](/docs/tutorials/ingest-images-and-audio#step-6--route-images-to-the-agent)
- [Ingest Images and Audio with Converters - Step 10 (Create the speech-to-text tool)](/docs/tutorials/ingest-images-and-audio#step-10--create-the-speech-to-text-tool)
- [Ingest Images and Audio with Converters - Step 12 (Route audio to the tool converter)](/docs/tutorials/ingest-images-and-audio#step-12--route-audio-to-the-tool-converter)

## Data Model

### IngestionRule

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Public identifier prefixed with `igr_` |
| `project_id` | string | ID of the owning project |
| `content_type_glob` | string | Glob matched against the file's `content_type` (`image/*`, `image/png`, `audio/mpeg`, `application/pdf`) |
| `tool_id` | string \| null | Converter tool (`tool_…`). Must be a server-callable type: `http`, `mcp`, `builtin`, or `pipeline`. `client` tools are rejected. Mutually exclusive with `agent_id`. |
| `agent_id` | string \| null | Converter agent (`agent_…`). The file is sent to the agent as multimodal input and its text output becomes the document content. Mutually exclusive with `tool_id`. |
| `action` | string \| null | Operation id, required for `builtin`/`mcp` tool converters |
| `preset_parameters` | object \| null | Merged into the tool input before invocation (tool converters only). Cannot contain the reserved keys `file` or `callback`, which ingestion injects. A key the converter tool itself pins in its own [`preset_parameters`](./tools.md#preset-parameters) stays pinned — the tool's value wins over the rule's. |
| `native_extraction` | string | For PDFs: `first` (default) converts only when native extraction yields no text; `skip` bypasses native extraction and converts every matching PDF. Ignored for non-native types. |
| `file_delivery` | string | How the file reaches a tool converter: `base64` (default) or `download_url` |
| `chunk_strategy` | string \| null | Optional default chunk strategy (`page`/`whole`/`size`), overridable per ingest request |
| `chunk_size` | number \| null | Optional default for the `size` strategy |
| `chunk_overlap` | number \| null | Optional default for the `size` strategy |
| `metadata` | object \| null | Arbitrary JSON metadata |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last-updated timestamp |

`project_id + content_type_glob` is unique. Exactly one of `tool_id` / `agent_id` must be set. A glob carries at most **4** wildcards and **255** characters; longer is refused with `INGESTION_RULE_VALIDATION_FAILED`.

## Key Concepts

### Content-Type Matching

`resolveIngestionRule` picks the most specific match: exact type (`image/png`) beats subtype wildcard (`image/*`) beats full wildcard (`*/*`).

Rules are consulted when:

1. **Non-native content type** — no [built-in extractor](./documents.md#file-ingestion-and-chunking).
2. **Empty native extraction** — a rule matching `application/pdf` is an **OCR fallback for scanned PDFs**: the built-in `unpdf` extractor runs first and the converter only when it returns no text.

With no matching rule, a non-native type is rejected with `UNSUPPORTED_FILE_TYPE` (`400`) and an empty native extraction fails with `FILE_PARSE_FAILED`.

### PDF Conversion Mode

`native_extraction` on the matching `application/pdf` rule: `first` (default) runs `unpdf` first and converts only PDFs with no text layer; `skip` converts **every** matching PDF (for unreliable text layers). No effect on non-native types.

### Converter: Tool or Agent

Exactly one of:

- **Tool converter** (`tool_id`): ingestion calls the tool with the JSON contract below and reads text from its response. Suits audio, specialized OCR APIs and long async jobs (the tool can defer via the callback).
- **Agent converter** (`agent_id`): ingestion sends the file as multimodal input with a fixed "extract all text / transcribe" instruction; the agent's text output becomes the content. The model must support the modality (**vision** for images and scanned PDFs, **audio-capable** for audio). The generation is awaited inline; no deferral/callback.

:::caution[Audio agent converters need a Chat Completions-compatible AI provider]
An [AI provider](./ai-providers.md) with the `openai` slug uses OpenAI's Responses API, which rejects audio input: the document fails with `CONVERTER_FAILED` (`AI_UnsupportedFunctionalityError: file part media type audio/...`). Register an audio-capable model (e.g. `gpt-audio-mini`) under the **`custom`** slug with `base_url` `https://api.openai.com/v1` (Chat Completions) instead. Vision converters are unaffected. Speech-to-text APIs that are not chat-completions-shaped (including xAI's) need a **tool converter**; see [Ingest Images and Audio with Converters](/docs/tutorials/ingest-images-and-audio).
:::

### Building a Tool Converter for a Third-Party API

No adapter service is needed: an [`http` tool](./tools.md#http) points `execute.url` at the third-party API, a [`pipeline` tool](./tools.md#pipeline) wrapping it reshapes request and response with JSON Logic, and `IngestionRule.tool_id` names the pipeline tool. Since the [Converter Tool Contract](#converter-tool-contract) accepts a bare string, the pipeline's `output` can be a single `var` (e.g. `{ "var": "steps.call.text" }`).

Hold the API key in a [Secret](./secrets.md) and use a [secret reference](./secrets.md#secret-references-secret) in `execute.headers`. For `multipart/form-data` APIs, set [`execute.body_mode: "multipart"`](./tools.md#request-body-encoding-body_mode); the `{ content_type, filename, data_base64 }` file shape is decoded and attached as a file part.

### Converter Tool Contract

A **tool** converter is called via the normal server-side tool path with a fixed input and one of three output shapes.

**Input** built by ingestion:

```jsonc
{
  "file": {
    "id": "file_01",
    "filename": "scan.png",
    "content_type": "image/png",
    "size": 20480,
    "data_base64": "iVBORw0KGgo…",        // when file_delivery = base64
    "download_url": "https://…/files/file_01/download?token=…" // when file_delivery = download_url
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

Any other shape fails the document with `CONVERTER_OUTPUT_INVALID`; a tool error with `CONVERTER_FAILED`. `{ "status": "pending" }` is honored only for a tool converter in the default **async** mode (see [Synchronous vs Async (Callback) Conversion](#synchronous-vs-async-callback-conversion)); an agent converter or a `?wait=true` request fails with `CONVERTER_FAILED`.

### File Delivery

`file_delivery` controls how the file bytes reach the tool's external API:

| Mode | Behavior | Use when |
|------|----------|----------|
| `base64` (default) | Ingestion downloads the file and passes `data_base64` in the tool input | Small files; provider-agnostic; works with any storage backend. Note: the whole file is loaded into memory and the request body. |
| `download_url` | Ingestion passes a short-lived signed `download_url`; the tool/API fetches it | Large files (long audio, high-resolution images/scans) where base64 is impractical, and providers that accept a remote URL |

### Synchronous vs Async (Callback) Conversion

A tool returning text (or `{ pages }`) is **synchronous**: chunking and embedding continue inline. An agent converter is always synchronous.

A tool returning `{ status: "pending" }` is **asynchronous**, only under default async ingestion ([`POST /documents/ingest`](/docs/api/documents/ingest-document) without `?wait=true`). The document stays in `processing` until the tool (or its service) posts the result to the ingestion-callback endpoint; see [Deliver an async converter result](/docs/api/documents/complete-ingestion-callback) for path, query token and schema. Document ID and token come from the `callback` block in the tool input ([Converter Tool Contract](#converter-tool-contract)); the body uses the synchronous output contract adapted for JSON (a single page is `{ "text": "..." }`, not a bare string).

The callback is authorized by a single-use signed token scoped to the document and ingestion attempt, not an IAM action. Accepted (`204`) only while that attempt is `processing`; a replay, a superseded attempt (after re-ingest), or arrival after the stall timeout is rejected with `409 INGESTION_CALLBACK_CONFLICT`; a bad token with `401 INGESTION_CALLBACK_INVALID_TOKEN`. A valid result runs the chunk + embed tail and marks the document `ready`.

`?wait=true` requests and agent converters fail immediately with `CONVERTER_FAILED` on `{ status: "pending" }`; a tool should defer only under async ingestion.

A document awaiting a callback longer than `CONVERSION_STALL_TIMEOUT_MS` is failed with `CONVERSION_TIMEOUT` (see [Configuration](#configuration)), the counterpart of [stuck-ingestion recovery](./documents.md#stuck-ingestion-recovery). A callback racing the timeout is settled by atomic compare-and-set: it wins or gets `409`, never silently dropped.

### Failure Reasons

Converter-related `failure_reason` values (alongside `FILE_PARSE_FAILED`, `INGESTION_TIMEOUT`):

| `failure_reason` | Meaning |
|------------------|---------|
| `CONVERTER_FAILED` | The converter tool/agent call errored, an agent converter returned an async deferral (unsupported), or a tool converter returned an async deferral during synchronous ingestion (`?wait=true`) |
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
  --tool-id tool_ocr \
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
    tool_id: 'tool_ocr',
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
    "tool_id": "tool_ocr",
    "file_delivery": "base64",
    "chunk_strategy": "whole"
  }'
```

</TabItem>
</Tabs>

For an agent converter pass `--agent-id` instead of `--tool-id`. [`POST /documents/ingest`](/docs/api/documents/ingest-document) routes matching files to the converter automatically; see [Documents](./documents.md#file-ingestion-and-chunking).

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
