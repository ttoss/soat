---
description: "Store documents with per-chunk embedding vectors for semantic search across project content in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Documents

The Documents module stores documents with per-chunk embedding vectors for semantic search across project content.

## Overview

A Document is backed by a [File](./files.md) and scoped to a project. Its content is split into **DocumentChunks**, each with its own embedding vector, for cosine-similarity search without an external vector database.

Two creation paths:

- **Plain text** ([`POST /documents`](/docs/api/documents/create-document)): inline content, a single chunk unless `chunk_strategy` splits it. Returns `201 Created`.
- **File ingestion** ([`POST /documents/ingest`](/docs/api/documents/ingest-document)): an uploaded file is parsed and chunked **asynchronously**; see [Async File Ingestion](#async-file-ingestion) and [File Ingestion and Chunking](#file-ingestion-and-chunking).

Ids are prefixed `doc_`; the internal primary key is never returned.

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Related Tutorials

- [Agent SOAT Tools and Preset Parameters - Step 4 (Create documents)](/docs/tutorials/agent-soat-tools#step-4--create-documents)
- [Multi-Agent Sonnet with Nested Agent Calls - Step 4 (Create a shared document)](/docs/tutorials/multi-agent-orchestration#step-4--create-a-shared-document-for-the-poem)
- [Orchestrate a Sonnet - Step 4 (Create the poem document)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool)

## Data Model

### Document

| Field        | Type           | Description                                                                                                        |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`         | string         | Public identifier prefixed with `doc_`                                                                             |
| `file_id`    | string         | ID of the underlying File record                                                                                   |
| `project_id` | string         | ID of the owning project                                                                                           |
| `path`       | string \| null | Logical path within the project (e.g. `/reports/q1.txt`). Also used as the resource ID segment in path-based SRNs. |
| `filename`   | string         | Original filename                                                                                                  |
| `content_type` | string       | Media type of the source file the document was ingested from (e.g. `application/pdf`). Absent when the underlying file is gone. |
| `size`       | number         | File size in bytes                                                                                                 |
| `status`     | string         | Ingestion lifecycle state: `pending` → `processing` → `ready` \| `failed`. Plain-text documents are always `ready`. |
| `title`      | string \| null | Human-readable title (auto-set to filename for PDF ingestion)                                                      |
| `metadata`   | object \| null | Arbitrary caller-supplied JSON metadata — never written or read by the server. Key casing is preserved verbatim — unlike other response fields, `metadata` keys are not converted between `snake_case` and `camelCase`. Ingestion progress (`chunk_count`, `total_pages`) and failure info (`error`) live on [`GET /documents/:id/status`](/docs/api/documents/get-document-status) instead — see [Polling Ingestion Status](#polling-ingestion-status). |
| `tags`       | object \| null | Key-value string tags                                                                                              |
| `content`    | string \| null | Joined chunk content — only present in [`GET /documents/:id`](/docs/api/documents/get-document) responses when `status` is `ready`                     |
| `chunk_strategy` | string | The chunk strategy the document was last (re-)ingested with (`page` \| `whole` \| `size`). Absent when the default (`whole`) was used — the key is omitted rather than sent as `null`. |
| `chunk_size`   | number | Window size in characters used when `chunk_strategy` is `size`. Absent otherwise.                                |
| `chunk_overlap`| number | Overlap in characters between consecutive windows used when `chunk_strategy` is `size`. Absent otherwise.        |
| `created_at` | string         | ISO 8601 creation timestamp                                                                                        |
| `updated_at` | string         | ISO 8601 last-updated timestamp                                                                                    |

### DocumentChunk (internal)

Chunks are not exposed directly; they are returned joined with newlines as `content` on [`GET /documents/:id`](/docs/api/documents/get-document) and used for embedding-based search.

| Field          | Type   | Description                                      |
| -------------- | ------ | ------------------------------------------------ |
| `chunk_index`  | number | Zero-based position of the chunk within the document |
| `page_number`  | number \| null | Source page number (PDF ingestion only)   |
| `content`      | string | Text of this chunk                               |
| `embedding`    | vector | pgvector embedding — stored but never returned   |

### Path Field

`path` defaults to `/<filename>`. Paths are absolute (start with `/`) and normalized (`.` and `..` resolved); `project_id + path` is unique. [`PATCH /documents/{document_id}`](/docs/api/documents/update-document) accepts `path` to move a document.

### Listing a Directory

[`GET /api/v1/documents`](/docs/api/documents/list-documents) accepts `path_prefix` to return one directory:

```bash
soat list-documents --project-id proj_ABC --path-prefix /reports/
```

The prefix is a **path boundary, not a substring**: `/reports` matches `/reports/q1.txt`, never `/reports-archive/q1.txt`. `reports`, `/reports` and `/reports/` are the same filter; `/` selects the whole project; `%` and `_` are literal. The filter runs in SQL with the policy filter, so `total` and pagination stay accurate per group.

## Key Concepts

### Async File Ingestion

[`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) returns `202 Accepted` by default; the document is created with `status: pending` and extraction + embedding run in the background. Poll [`GET /api/v1/documents/:id`](/docs/api/documents/get-document) until `status` is `ready` or `failed`.

`?wait=true` blocks until completion and returns `201 Created` with `status: ready` (or `failed`). See [Synchronous & Asynchronous Execution](../advanced/sync-and-async.md) for the platform-wide `wait` contract. A file larger than `SYNC_INGESTION_MAX_BYTES` (default 10 MB) is rejected with `413 FILE_TOO_LARGE_FOR_SYNC`; ingest it in background mode instead.

### Polling Ingestion Status

[`GET /documents/:id`](/docs/api/documents/get-document) returns the full chunk content, which can be megabytes. [`GET /api/v1/documents/:id/status`](/docs/api/documents/get-document-status) returns only the lifecycle fields:

```json
{
  "id": "doc_V1StGXR8Z5jdHi6B",
  "status": "processing",
  "chunk_count": 7,
  "total_chunks": 12,
  "total_pages": 12,
  "progress": 58,
  "error": null
}
```

Field semantics (they change with `status`):

| Field | Meaning |
| --- | --- |
| `status` | `pending` → `processing` → `ready` \| `failed` |
| `chunk_count` | Chunks **currently indexed** — a live count. It is `0` while `pending`, grows during `processing`, and equals the final total once `ready`. |
| `total_chunks` | Planned total number of chunks, known once chunking begins (`null` until then). The denominator for `progress`. |
| `total_pages` | Source pages extracted. `null` until extraction has run (i.e. until `ready`/`failed`); `null` is not the same as zero pages. |
| `progress` | Percentage `chunk_count / total_chunks`. `0` while `pending`, climbs while `processing` (capped at `99`), `100` when `ready`, `null` when `failed` or not yet computable. |
| `error` | The `failure_reason` (e.g. `FILE_PARSE_FAILED`, `INGESTION_TIMEOUT`). Only set when `status` is `failed`; otherwise `null`. |

### Ingestion Events

Every path that settles an ingestion (pipeline, async converter callback, stall
sweeper) emits a terminal event on the project event bus, deliverable through a
[webhook](./webhooks.md):

| Event | Emitted when | Extra `data` field |
| --- | --- | --- |
| `documents.ingested` | The document reached `status: ready` and its chunks are queryable | `chunk_count` — the final number of chunks indexed |
| `documents.ingest_failed` | The ingestion settled in `status: failed` | `error` — the same reason [`GET /documents/:id/status`](/docs/api/documents/get-document-status) reports |

Both carry the document in `data` in REST shape. A re-ingest emits a fresh event
each time it settles; a document stuck in `processing` emits nothing until the
stall sweeper fails it (see [Stuck Ingestion Recovery](#stuck-ingestion-recovery)).

### Stuck Ingestion Recovery

A document left in `processing` (or `pending`) by a dead worker is **self-recovered**: when read via [`GET /documents/:id`](/docs/api/documents/get-document) or [`GET /documents/:id/status`](/docs/api/documents/get-document-status) after no progress for `INGESTION_STALL_TIMEOUT_MS` (default 5 minutes), it transitions to `failed` with `error = INGESTION_TIMEOUT`. Re-process it with the re-ingest endpoint below.

### Re-ingesting a Document

[`POST /api/v1/documents/:id/ingest`](/docs/api/documents/reingest-document) re-runs ingestion against the stored source file: chunks are discarded and the document reset to `status: pending`. Use it to recover a failed document or re-chunk with a different `chunk_strategy`. It accepts the same `chunk_strategy` / `chunk_size` / `chunk_overlap` fields and `?wait=` toggle as [`POST /documents/ingest`](/docs/api/documents/ingest-document), returning `202` (default) or `201` (`?wait=true`).

**Lifecycle states:**

| Status       | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `pending`    | Enqueued; background worker has not started yet                                   |
| `processing` | Actively extracting pages, chunking, and generating embeddings                    |
| `ready`      | Fully indexed; content and chunk embeddings are available for search              |
| `failed`     | Processing encountered an error. The `error` field on [`GET /documents/:id/status`](/docs/api/documents/get-document-status) describes it |

`error` values: `FILE_PARSE_FAILED` (no extractable text and no matching converter rule), `FILE_NOT_FOUND`, `INGESTION_TIMEOUT` (see [Stuck Ingestion Recovery](#stuck-ingestion-recovery)); with an [Ingestion Rule](./ingestion-rules.md), also `CONVERTER_FAILED`, `CONVERTER_OUTPUT_INVALID`, and `CONVERSION_TIMEOUT`.

Embedding concurrency is bounded (default 5 simultaneous requests).

### File Ingestion and Chunking

[`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) ingests a file uploaded via [`POST /api/v1/files/upload`](/docs/api/files/upload-file). Format is detected from `content_type`:

| Content type     | How the source text is extracted |
| ---------------- | -------------------------------- |
| `application/pdf`| Parsed page-by-page; blank pages are dropped. If no text is extracted (e.g. a scanned PDF), ingestion falls back to a converter tool when an [Ingestion Rule](./ingestion-rules.md) matches `application/pdf`. |
| `text/plain`     | Read as a single source page     |
| `text/markdown`  | Read as a single source page     |
| other (`image/*`, `audio/*`, …) | Converted to text by the tool named in the matching [Ingestion Rule](./ingestion-rules.md), then chunked normally |

A content type with no built-in extractor and no matching [Ingestion Rule](./ingestion-rules.md) is rejected with `UNSUPPORTED_FILE_TYPE` (`400`).

`file_id` is unique across documents; ingesting an already-ingested file returns `409 FILE_ALREADY_INGESTED`. Use [Re-ingesting a Document](#re-ingesting-a-document) to re-chunk or recover it; upload a new copy to ingest the same source under another path.

Extracted text is split by `chunk_strategy`:

- **`chunk_strategy: page`** (default): one chunk per source page with `page_number` set (PDF only; non-paged sources yield one chunk).
- **`chunk_strategy: whole`**: a single chunk, source text joined by newlines.
- **`chunk_strategy: size`**: fixed-size character windows with overlap, `chunk_size` (default `1000`) and `chunk_overlap` (default `200`). Page attribution is dropped.

[`POST /api/v1/documents`](/docs/api/documents/create-document) accepts the same options with default strategy `whole`.

Embeddings are computed concurrently across chunks; an embedding failure is non-fatal and the chunk is stored without a vector. `chunk_count` on [`GET /documents/:id/status`](/docs/api/documents/get-document-status) can differ from `total_pages`: `whole` gives `1`, `size` depends on text length.

The last-used `chunk_strategy` / `chunk_size` / `chunk_overlap` are persisted on the document, so a [Formation](./formations.md) `document` resource re-plan converges to a no-op. Changing a formation document's `chunk_strategy` re-chunks the stored text on the next `update-formation`.

### Path-Based SRNs

Policies can target documents by `path`; the server evaluates **both** the id-based and path-based SRN. Worked example: [Agent SOAT Tools and Preset Parameters — Step 4 (Create documents)](/docs/tutorials/agent-soat-tools#step-4--create-documents):

| SRN form                                 | Matches                                      |
| ---------------------------------------- | -------------------------------------------- |
| `srn:proj_ABC:document:doc_XYZ`         | Specific document by ID                      |
| `srn:proj_ABC:document:/reports/q1.txt` | Document at the exact path `/reports/q1.txt` |
| `srn:proj_ABC:document:/reports/*`      | All documents under `/reports/`              |
| `srn:proj_ABC:document:*`               | All documents in the project (id wildcard)   |
| `*`                                      | All resources in the project                 |

List and search apply policy filters in SQL, so pagination counts are accurate. SRN syntax: [IAM Reference](iam.md).

### Project ID Resolution

`project_id` is optional; when omitted, accessible projects are resolved from the caller's policies (an API key is scoped to its project). A supplied `project_id` the policies do not grant returns `403 Forbidden`. See [IAM — Authorization Model](iam.md#authorization-model).

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are written (shared with Files) |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend: `ollama`, `openai`, or `bedrock`          |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024`, and be at most `2000` |
| `OLLAMA_BASE_URL`      | No       | Ollama server URL, defaults to `http://localhost:11434`      |
| `SYNC_INGESTION_MAX_BYTES` | No   | Max file size (bytes) allowed for synchronous ingestion (`?wait=true`). Larger files return `413`. Defaults to `10485760` (10 MB). |
| `INGESTION_STALL_TIMEOUT_MS` | No | How long (ms) a document may stay in `pending`/`processing` with no progress before it is auto-failed with `INGESTION_TIMEOUT`. Defaults to `300000` (5 min). |

Ollama setup: `ollama pull qwen3-embedding:0.6b`, then set `EMBEDDING_PROVIDER=ollama`, `EMBEDDING_MODEL=qwen3-embedding:0.6b`, `EMBEDDING_DIMENSIONS=1024`, and (if not local) `OLLAMA_BASE_URL`.

## Examples

### Create a document

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-document \
  --project-id proj_ABC \
  --filename q1-report.txt \
  --path /reports/q1-report.txt \
  --content "Q1 revenue was \$1.2M..."
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({
  baseUrl: 'https://api.example.com',
  token: 'sk_...',
});

const { data, error } = await soat.documents.createDocument({
  body: {
    project_id: 'proj_ABC',
    filename: 'q1-report.txt',
    path: '/reports/q1-report.txt',
    content: 'Q1 revenue was $1.2M...',
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/documents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "filename": "q1-report.txt",
    "path": "/reports/q1-report.txt",
    "content": "Q1 revenue was $1.2M..."
  }'
```

</TabItem>
</Tabs>

### Ingest a file

Upload via [`POST /api/v1/files/upload`](/docs/api/files/upload-file), then call [`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) with the returned `file_id`. Works for PDFs and `text/*` files alike.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Step 1: upload the file (PDF, .txt, or .md). The CLI sends the bytes
# base64-encoded; for a large file, use the presigned-token flow instead
# (see the Files module).
FILE_ID=$(soat upload-file-base64 \
  --project-id proj_ABC \
  --content "$(base64 -w0 ./report.pdf)" \
  --filename report.pdf \
  --content-type application/pdf | jq -r '.id')

# Step 2: ingest — one chunk per page (default)
soat ingest-document \
  --project-id proj_ABC \
  --file-id "$FILE_ID" \
  --path-prefix /reports/
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

// Step 1: upload the file
const formData = new FormData();
formData.append('file', pdfBlob, 'report.pdf');
formData.append('project_id', 'proj_ABC');
const { data: file, error: uploadErr } = await soat.files.uploadFile({ body: formData });
if (uploadErr) throw new Error(JSON.stringify(uploadErr));

// Step 2: ingest (returns 202 immediately)
const { data, error } = await soat.documents.ingestDocument({
  body: {
    file_id: file.id,
    project_id: 'proj_ABC',
    path_prefix: '/reports/',
  },
});
if (error) throw new Error(JSON.stringify(error));
console.log(`Enqueued document ${data.id}, status=${data.status}`);

// Step 3: poll the lightweight status endpoint until ready
let status = data;
while (status.status === 'pending' || status.status === 'processing') {
  await new Promise((r) => setTimeout(r, 500));
  const { data: polled } = await soat.documents.getDocumentStatus({ path: { document_id: data.id } });
  status = polled!;
}
if (status.status === 'failed') {
  throw new Error(`Ingestion failed: ${status.error ?? 'unknown'}`);
}
console.log(`Ready — ${status.chunk_count} chunks`);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Step 1: upload the file
FILE_ID=$(curl -sX POST https://api.example.com/api/v1/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@report.pdf" \
  -F "project_id=proj_ABC" | jq -r '.id')

# Step 2: ingest
curl -X POST https://api.example.com/api/v1/documents/ingest \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"proj_ABC\",
    \"file_id\": \"$FILE_ID\",
    \"path_prefix\": \"/reports/\"
  }"
```

</TabItem>
</Tabs>
