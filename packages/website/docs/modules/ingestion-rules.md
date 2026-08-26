---
description: "Route a file content_type to a converter tool so images, audio, and scanned PDFs can be ingested into searchable documents."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Ingestion Rules

An Ingestion Rule routes a file `content_type` to a converter [Tool](./tools.md) so that non-text files (images, audio, scanned PDFs) can be ingested into [Documents](./documents.md).

## Overview

Native [file ingestion](./documents.md#file-ingestion-and-chunking) only extracts text from PDFs (text layer), `text/plain`, and `text/markdown`. Anything else fails with `FILE_PARSE_FAILED`. An Ingestion Rule fills that gap: it maps a `content_type` glob (e.g. `image/*`, `audio/mpeg`, `application/pdf`) to a **converter** — either a [Tool](./tools.md) (`http`/`mcp`/`builtin`/`pipeline`) that calls an external OCR, speech-to-text, or vision service, or an [Agent](./agents.md) with a multimodal model. When [`POST /documents/ingest`](/docs/api/documents/ingest-document) receives a file whose type has no native extractor — or a PDF whose native extraction yields no text — it looks up the best-matching rule and invokes the converter to produce the document text; the existing chunk + embedding pipeline is unchanged.

Rules are per-project. SOAT does not perform OCR or transcription itself — the rule points at a tool or agent you configure, so you can use any API or model you like. In the [engine & algorithms pattern](../advanced/engines-and-algorithms.md), a converter tool is the knowledge engine's bring-your-own-algorithm seam: the [contract below](#converter-tool-contract) is the boundary, and everything downstream (chunking, embedding, retrieval) treats your converter's pages exactly like natively extracted ones.

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

`project_id + content_type_glob` is unique within a project — one rule per glob. Exactly one of `tool_id` / `agent_id` must be set.

## Key Concepts

### Content-Type Matching

At ingest time, `resolveIngestionRule` picks the matching rule with the highest specificity: an exact type (`image/png`) beats a subtype wildcard (`image/*`), which beats a full wildcard (`*/*`).

Rules are consulted in two cases:

1. **Non-native content type** — the file type has no [built-in extractor](./documents.md#file-ingestion-and-chunking).
2. **Empty native extraction** — a native type produced no text. In particular, a rule matching `application/pdf` acts as an **OCR fallback for scanned/image-only PDFs**: the built-in `unpdf` extractor runs first, and only when it returns no text does ingestion invoke the converter. Born-digital PDFs with a text layer skip the converter, so there is no added cost for the common case.

When no rule matches, behavior is unchanged: a non-native type is rejected with `UNSUPPORTED_FILE_TYPE` (`400`), and an empty native extraction fails the document with `FILE_PARSE_FAILED`.

### PDF Conversion Mode

For PDFs, `native_extraction` on the matching `application/pdf` rule controls when the converter runs: `first` (default) runs native `unpdf` extraction first and converts only PDFs with no text layer; `skip` bypasses native extraction so **every** matching PDF is converted (use when the text layer is unreliable). It has no effect on non-native types — their converter always runs.

### Converter: Tool or Agent

A rule's converter is either a [Tool](./tools.md) or an [Agent](./agents.md) (exactly one):

- **Tool converter** (`tool_id`) — ingestion calls the tool with the JSON contract below and reads text from its response. Best for audio, specialized OCR APIs, and long async jobs (the tool can defer via the callback).
- **Agent converter** (`agent_id`) — ingestion sends the file to the agent as multimodal input with a fixed "extract all text / transcribe" instruction; the agent's text output becomes the document content. Zero extra infrastructure, but the agent's model must support the file's modality (a **vision** model for images and scanned PDFs; an **audio-capable** model for audio). The generation is awaited inline — there is no deferral/callback for agent converters.

:::caution[Audio agent converters need a Chat Completions-compatible AI provider]
An agent whose [AI provider](./ai-providers.md) uses the `openai` provider slug talks to OpenAI's Responses API, which does not accept audio input — an audio file routed to such an agent fails with `CONVERTER_FAILED` (`AI_UnsupportedFunctionalityError: file part media type audio/...`). To use an OpenAI audio-capable model (e.g. `gpt-audio-mini`) as an audio converter, register it with the **`custom`** provider slug and `base_url` pointed at `https://api.openai.com/v1` instead — that path uses the Chat Completions API, which does support audio input. Vision (image) agent converters are unaffected. Many dedicated speech-to-text APIs (including xAI's) aren't chat-completions-shaped at all, in which case a **tool converter** is the better fit regardless — see [Ingest Images and Audio with Converters](/docs/tutorials/ingest-images-and-audio) for a worked example of both converter kinds.
:::

### Building a Tool Converter for a Third-Party API

A tool converter does not require a separate adapter service. An [`http` tool](./tools.md#http) can point `execute.url` directly at a third-party API, and a [`pipeline` tool](./tools.md#pipeline) wrapping it reshapes request and response with the usual JSON Logic mapping; point `IngestionRule.tool_id` at the pipeline tool. Because the [Converter Tool Contract](#converter-tool-contract) accepts a bare string, the pipeline's `output` can be a single `var` expression (e.g. `{ "var": "steps.call.text" }`).

Hold the third-party API key in a [Secret](./secrets.md) and embed a [secret reference](./secrets.md#secret-references-secret) in the `http` tool's `execute.headers` rather than pasting the raw key. For APIs that require `multipart/form-data` (many speech-to-text and OCR endpoints), set [`execute.body_mode: "multipart"`](./tools.md#request-body-encoding-body_mode) on the `http` tool — the `{ content_type, filename, data_base64 }` file shape ingestion provides is decoded and attached as a real file part.

### Converter Tool Contract

A **tool** converter is called via the same server-side path as every other tool call, with a fixed input shape, and must return one of three output shapes.

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

Any other shape fails the document with `CONVERTER_OUTPUT_INVALID`; a tool error fails it with `CONVERTER_FAILED`. `{ "status": "pending" }` is only honored for a tool converter ingested in the default **async** mode (see [Synchronous vs Async (Callback) Conversion](#synchronous-vs-async-callback-conversion)) — an agent converter, or a synchronous ingest request (`?wait=true`), fails with `CONVERTER_FAILED` instead, since neither can wait for a later callback.

### File Delivery

`file_delivery` controls how the file bytes reach the tool's external API:

| Mode | Behavior | Use when |
|------|----------|----------|
| `base64` (default) | Ingestion downloads the file and passes `data_base64` in the tool input | Small files; provider-agnostic; works with any storage backend. Note: the whole file is loaded into memory and the request body. |
| `download_url` | Ingestion passes a short-lived signed `download_url`; the tool/API fetches it | Large files (long audio, high-resolution images/scans) where base64 is impractical, and providers that accept a remote URL |

### Synchronous vs Async (Callback) Conversion

A converter tool that returns text (or `{ pages }`) directly is **synchronous** — ingestion continues to chunk and embed inline. An agent converter is always synchronous: its generation is awaited inline and it has no deferral path.

A tool that returns `{ status: "pending" }` is **asynchronous** — but only when the document is being ingested in the default async mode ([`POST /documents/ingest`](/docs/api/documents/ingest-document) without `?wait=true`). The document stays in `processing` while the external job runs, then the tool (or the service it wires) delivers the result to the Documents module's ingestion-callback endpoint — see [Deliver an async converter result](/docs/api/documents/complete-ingestion-callback) in the API reference for its path, query token, and request schema.

The callback's document ID and token come from the `callback` block ingestion injected into the tool's input (see [Converter Tool Contract](#converter-tool-contract)); its body uses the same output contract as a synchronous converter, adapted for a JSON body (a single page is `{ "text": "..." }` rather than a bare string, since a top-level JSON string is not a valid HTTP JSON body).

The callback is authorized by a single-use, signed token scoped to that document and ingestion attempt — not by an IAM action, since the external converter is not a SOAT user. It is accepted (`204`) only while that attempt is still `processing`; a replayed callback, a callback for a superseded attempt (after re-ingest), or one that arrives after the stall timeout already failed the document is rejected with `409 INGESTION_CALLBACK_CONFLICT`. An invalid or mismatched token is rejected with `401 INGESTION_CALLBACK_INVALID_TOKEN`. Once a valid result arrives, ingestion runs the normal chunk + embed tail and marks the document `ready`.

If a synchronous ingest request (`?wait=true`) or an agent converter encounters `{ status: "pending" }`, the document fails immediately with `CONVERTER_FAILED` — neither can wait for a callback that may arrive arbitrarily later. Design a tool that might defer to only do so under async ingestion.

A document awaiting a callback for longer than `CONVERSION_STALL_TIMEOUT_MS` is auto-failed with `CONVERSION_TIMEOUT` (see [Configuration](#configuration)) — the converter-specific counterpart of [stuck-ingestion recovery](./documents.md#stuck-ingestion-recovery). A callback racing the timeout is settled by an atomic compare-and-set: it either wins outright or is rejected with `409`, never silently dropped.

### Failure Reasons

Converter-related `failure_reason` values that can appear on a failed document (alongside the existing `FILE_PARSE_FAILED`, `INGESTION_TIMEOUT`):

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

To create an agent-converter rule instead, pass `--agent-id` in place of `--tool-id` (e.g. a vision agent on `application/pdf` as an OCR fallback for scanned PDFs). Ingesting a matching file needs nothing special — [`POST /documents/ingest`](/docs/api/documents/ingest-document) routes it to the converter automatically; see [Documents](./documents.md#file-ingestion-and-chunking).

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
