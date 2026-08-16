---
description: "Store documents with per-chunk embedding vectors for semantic search across project content in SOAT."
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Documents

The Documents module stores documents with per-chunk embedding vectors for semantic search across project content.

## Overview

A Document is backed by a [File](./files.md) and associated with a project. When a document is created, its content is split into one or more **DocumentChunks** — each chunk has its own embedding vector. This enables cosine-similarity search at query time without an external vector database.

Documents can be created in two ways:

- **Plain text** ([`POST /documents`](/docs/api/documents/create-document)) — content is supplied inline; stored as a single chunk unless `chunk_strategy` splits it. Returns `201 Created`.
- **File ingestion** ([`POST /documents/ingest`](/docs/api/documents/ingest-document)) — an already-uploaded file is parsed and chunked **asynchronously**; see [Async File Ingestion](#async-file-ingestion) and [File Ingestion and Chunking](#file-ingestion-and-chunking).

Documents are identified by an `id` prefixed with `doc_`. The internal database primary key is never returned.

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

Each Document has one or more chunks stored in the database. Chunks are not directly exposed via the REST API but are returned as the `content` field on [`GET /documents/:id`](/docs/api/documents/get-document) (joined with newlines) and used for embedding-based search.

| Field          | Type   | Description                                      |
| -------------- | ------ | ------------------------------------------------ |
| `chunk_index`  | number | Zero-based position of the chunk within the document |
| `page_number`  | number \| null | Source page number (PDF ingestion only)   |
| `content`      | string | Text of this chunk                               |
| `embedding`    | vector | pgvector embedding — stored but never returned   |

### Path Field

`path` is optional at creation time; if omitted, the server defaults to `/<filename>`. Paths must be absolute (start with `/`) and are normalized (`.` and `..` are resolved). `project_id + path` is unique within a project. [`PATCH /documents/{document_id}`](/docs/api/documents/update-document) accepts a `path` field to move a document.

## Key Concepts

### Async File Ingestion

[`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) returns `202 Accepted` immediately by default. The document record is created with `status: pending` and chunk extraction + embedding run in the background. Poll [`GET /api/v1/documents/:id`](/docs/api/documents/get-document) until `status` is `ready` or `failed`.

Pass `?wait=true` to block until processing completes. The endpoint then returns `201 Created` with `status: ready` (or `status: failed` on error) — no polling required. This is useful for small files or scripted workflows where latency is acceptable. See [Synchronous & Asynchronous Execution](../advanced/sync-and-async.md) for the platform-wide `wait` contract.

Synchronous ingestion is bounded by file size: a file larger than `SYNC_INGESTION_MAX_BYTES` (default 10 MB) is rejected with `413 FILE_TOO_LARGE_FOR_SYNC` rather than blocking the request until it times out. Retry such files in the default background mode (omit `?wait=true`) and poll the status endpoint.

### Polling Ingestion Status

Polling [`GET /documents/:id`](/docs/api/documents/get-document) returns the full document including the assembled chunk content, which can be several megabytes. To check ingestion progress cheaply, use [`GET /api/v1/documents/:id/status`](/docs/api/documents/get-document-status) instead — it returns only the lifecycle fields:

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

Because chunks are persisted incrementally as their embeddings complete, `chunk_count` and `progress` advance during `processing` rather than jumping from `0` to the total at the end. This is the recommended endpoint for both async ingestion polling and quick status checks.

### Stuck Ingestion Recovery

If an ingestion worker dies mid-processing, a document can be left in `processing` (or `pending`) indefinitely. Such a document is **self-recovered**: when it is read via [`GET /documents/:id`](/docs/api/documents/get-document) or [`GET /documents/:id/status`](/docs/api/documents/get-document-status) and has made no progress for longer than `INGESTION_STALL_TIMEOUT_MS` (default 5 minutes), it is transitioned to `failed` with `error = INGESTION_TIMEOUT` on the status response. From there it can be re-processed with the re-ingest endpoint below.

### Re-ingesting a Document

[`POST /api/v1/documents/:id/ingest`](/docs/api/documents/reingest-document) re-runs ingestion for an existing document against its already-stored source file. Existing chunks are discarded and the document is reset to `status: pending` before re-processing. Use it to recover a stuck or failed document, or to re-chunk an existing document with a different `chunk_strategy`, without deleting and re-uploading the file. It accepts the same `chunk_strategy` / `chunk_size` / `chunk_overlap` body fields and `?wait=` toggle as [`POST /documents/ingest`](/docs/api/documents/ingest-document), and returns `202` (background, default) or `201` (`?wait=true`).

**Lifecycle states:**

| Status       | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `pending`    | Enqueued; background worker has not started yet                                   |
| `processing` | Actively extracting pages, chunking, and generating embeddings                    |
| `ready`      | Fully indexed; content and chunk embeddings are available for search              |
| `failed`     | Processing encountered an error. The `error` field on [`GET /documents/:id/status`](/docs/api/documents/get-document-status) describes it |

Common `error` values: `FILE_PARSE_FAILED` (no extractable text and no matching converter rule), `FILE_NOT_FOUND`, `INGESTION_TIMEOUT` (ingestion stalled and was auto-recovered — see [Stuck Ingestion Recovery](#stuck-ingestion-recovery)). When conversion via an [Ingestion Rule](./ingestion-rules.md) is involved, `CONVERTER_FAILED`, `CONVERTER_OUTPUT_INVALID`, and `CONVERSION_TIMEOUT` may also appear.

Embedding concurrency is bounded (default: 5 simultaneous requests) to avoid overwhelming the embedding service on large documents.

### File Ingestion and Chunking

[`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) ingests an already-uploaded file (uploaded via [`POST /api/v1/files/upload`](/docs/api/files/upload-file)). The source format is detected from the file's `content_type`:

| Content type     | How the source text is extracted |
| ---------------- | -------------------------------- |
| `application/pdf`| Parsed page-by-page; blank pages are dropped. If no text is extracted (e.g. a scanned PDF), ingestion falls back to a converter tool when an [Ingestion Rule](./ingestion-rules.md) matches `application/pdf`. |
| `text/plain`     | Read as a single source page     |
| `text/markdown`  | Read as a single source page     |
| other (`image/*`, `audio/*`, …) | Converted to text by the tool named in the matching [Ingestion Rule](./ingestion-rules.md), then chunked normally |

A content type with no built-in extractor and no matching [Ingestion Rule](./ingestion-rules.md) is rejected with `UNSUPPORTED_FILE_TYPE` (`400`).

A file can back only one Document — `file_id` is unique across documents. Calling [`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) again with a `file_id` that already has a document returns `409 FILE_ALREADY_INGESTED`. To re-chunk or recover that same document (e.g. with a different `chunk_strategy`), use [Re-ingesting a Document](#re-ingesting-a-document) instead; to ingest the same source under a different path, upload a new copy of the file and ingest that.

The extracted text is then split into one or more DocumentChunks according to `chunk_strategy`:

- **`chunk_strategy: page`** (default) — one chunk per source page; `page_number` is set on each chunk (PDF only — non-paged sources yield a single chunk).
- **`chunk_strategy: whole`** — a single chunk with all source text joined by newlines.
- **`chunk_strategy: size`** — fixed-size character windows with overlap, controlled by `chunk_size` (default `1000`) and `chunk_overlap` (default `200`). Page attribution is dropped.

The same `chunk_strategy` / `chunk_size` / `chunk_overlap` options are also accepted by [`POST /api/v1/documents`](/docs/api/documents/create-document) (plain text), where the default strategy is `whole`.

Each chunk gets its own embedding vector, enabling fine-grained semantic search that can cite specific page numbers. Embeddings are computed concurrently across chunks, and an embedding failure is non-fatal — the chunk is stored without a vector.

After ingestion completes, [`GET /documents/:id/status`](/docs/api/documents/get-document-status) reports the number of chunks created as `chunk_count`. Note this can differ from `total_pages`: with `whole` it is always `1`, and with `size` it depends on the text length.

The chunk configuration a document was last (re-)ingested with is persisted on the document itself and returned as `chunk_strategy` / `chunk_size` / `chunk_overlap`. This lets a [Formation](./formations.md) `document` resource read its chunk settings back, so a re-plan of an unchanged template converges to a no-op instead of perpetually re-reporting these fields as changed. Updating a formation document's `chunk_strategy` re-chunks the stored source text on the next `update-formation` (no out-of-band re-ingest required).

### Path-Based SRNs

Policies can target documents by their logical path rather than their `id`. When a document has a `path` set, the server evaluates **both** the id-based SRN and the path-based SRN. For a worked example that scopes an agent to a public document path while denying a private one, see [Agent SOAT Tools and Preset Parameters — Step 4 (Create documents)](/docs/tutorials/agent-soat-tools#step-4--create-documents):

| SRN form                                 | Matches                                      |
| ---------------------------------------- | -------------------------------------------- |
| `soat:proj_ABC:document:doc_XYZ`         | Specific document by ID                      |
| `soat:proj_ABC:document:/reports/q1.txt` | Document at the exact path `/reports/q1.txt` |
| `soat:proj_ABC:document:/reports/*`      | All documents under `/reports/`              |
| `soat:proj_ABC:document:*`               | All documents in the project (id wildcard)   |
| `*`                                      | All resources in the project                 |

List and search endpoints apply policy filters at the SQL level — the database returns only rows the caller is permitted to see, so pagination counts are always accurate.

See the [IAM Reference](iam.md) for full SRN syntax and policy authoring guidance.

### Project ID Resolution

For endpoints that accept `project_id`, the field is optional: when omitted, the server resolves the accessible projects from the caller's effective policies (an API key is scoped to its own project). If `project_id` is supplied but the caller's policies do not grant the required action on it, the request returns `403 Forbidden`. See [IAM — Authorization Model](iam.md#authorization-model).

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are written (shared with Files) |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend — only `ollama` is supported               |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024` |
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

First upload the file via [`POST /api/v1/files/upload`](/docs/api/files/upload-file), then call [`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) with the returned `file_id`. Works for PDFs and `text/*` files alike.

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
