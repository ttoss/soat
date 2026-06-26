import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Documents

The Documents module stores documents with per-chunk embedding vectors for semantic search across project content.

## Overview

A Document is backed by a [File](./files.md) and associated with a project. When a document is created, its content is split into one or more **DocumentChunks** — each chunk has its own embedding vector. This enables cosine-similarity search at query time without an external vector database.

Documents can be created in two ways:

- **Plain text** (`POST /documents`) — content is supplied inline. By default it is stored as a single chunk; pass `chunk_strategy` to split it. The response is `201 Created`. See it end to end in [Orchestrate a Sonnet — Step 4 (Create the poem document)](/docs/tutorials/orchestrate-a-sonnet#step-4--create-the-poem-document-and-a-fixed-write-tool).
- **File ingestion** (`POST /documents/ingest`) — an already-uploaded file is parsed and chunked **asynchronously**. The endpoint returns `202 Accepted` immediately with the new document in `status: pending`. Chunk extraction and embedding run in the background; poll `GET /documents/:id` until `status` is `ready` or `failed`. The source format is detected from the file's content type: PDFs are parsed page by page (`application/pdf`); `text/plain` and `text/markdown` files are read as a single source. How the source is chunked is controlled by `chunk_strategy`.

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
| `metadata`   | object \| null | Arbitrary JSON metadata. After ingestion: `source_file_id`, `total_pages`, `chunk_count`. On failure: `failure_reason`. |
| `tags`       | object \| null | Key-value string tags                                                                                              |
| `content`    | string \| null | Joined chunk content — only present in `GET /documents/:id` responses when `status` is `ready`                     |
| `created_at` | string         | ISO 8601 creation timestamp                                                                                        |
| `updated_at` | string         | ISO 8601 last-updated timestamp                                                                                    |

### DocumentChunk (internal)

Each Document has one or more chunks stored in the database. Chunks are not directly exposed via the REST API but are returned as the `content` field on `GET /documents/:id` (joined with newlines) and used for embedding-based search.

| Field          | Type   | Description                                      |
| -------------- | ------ | ------------------------------------------------ |
| `chunk_index`  | number | Zero-based position of the chunk within the document |
| `page_number`  | number \| null | Source page number (PDF ingestion only)   |
| `content`      | string | Text of this chunk                               |
| `embedding`    | vector | pgvector embedding — stored but never returned   |

### Path Field

The `path` field is a logical, project-scoped identifier for a document — similar to a file path in a filesystem. It is optional at creation time; if omitted, the server defaults to `/<filename>`. Paths must be absolute (start with `/`) and are normalized (`.` and `..` are resolved). The combination of `project_id + path` is unique within a project.

Path examples:

```
/reports/q1.txt
/datasets/raw/2024-01-01.txt
```

`PATCH /documents/:id` accepts a `path` field to move a document to a new logical path.

## Key Concepts

### Async File Ingestion

`POST /api/v1/documents/ingest` returns `202 Accepted` immediately by default. The document record is created with `status: pending` and chunk extraction + embedding run in the background. Poll `GET /api/v1/documents/:id` until `status` is `ready` or `failed`.

Pass `?async=false` to block until processing completes. The endpoint then returns `201 Created` with `status: ready` (or `status: failed` on error) — no polling required. This is useful for small files or scripted workflows where latency is acceptable. (This mirrors the `?async=` toggle on `POST /api/v1/sessions/:id/generate`, except ingestion defaults to async.)

Synchronous ingestion is bounded by file size: a file larger than `SYNC_INGESTION_MAX_BYTES` (default 10 MB) is rejected with `413 FILE_TOO_LARGE_FOR_SYNC` rather than blocking the request until it times out. Retry such files in async mode and poll the status endpoint.

### Polling Ingestion Status

Polling `GET /documents/:id` returns the full document including the assembled chunk content, which can be several megabytes. To check ingestion progress cheaply, use `GET /api/v1/documents/:id/status` instead — it returns only the lifecycle fields:

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

If an ingestion worker dies mid-processing, a document can be left in `processing` (or `pending`) indefinitely. Such a document is **self-recovered**: when it is read via `GET /documents/:id` or `GET /documents/:id/status` and has made no progress for longer than `INGESTION_STALL_TIMEOUT_MS` (default 5 minutes), it is transitioned to `failed` with `metadata.failure_reason = INGESTION_TIMEOUT`. From there it can be re-processed with the re-ingest endpoint below.

### Re-ingesting a Document

`POST /api/v1/documents/:id/ingest` re-runs ingestion for an existing document against its already-stored source file. Existing chunks are discarded and the document is reset to `status: pending` before re-processing. Use it to recover a stuck or failed document, or to re-chunk an existing document with a different `chunk_strategy`, without deleting and re-uploading the file. It accepts the same `chunk_strategy` / `chunk_size` / `chunk_overlap` body fields and `?async=` toggle as `POST /documents/ingest`, and returns `202` (async, default) or `201` (sync).

**Lifecycle states:**

| Status       | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `pending`    | Enqueued; background worker has not started yet                                   |
| `processing` | Actively extracting pages, chunking, and generating embeddings                    |
| `ready`      | Fully indexed; content and chunk embeddings are available for search              |
| `failed`     | Processing encountered an error. The `metadata.failure_reason` field describes it |

Common `failure_reason` values: `FILE_PARSE_FAILED` (no extractable text), `FILE_NOT_FOUND`, `INGESTION_TIMEOUT` (ingestion stalled and was auto-recovered — see [Stuck Ingestion Recovery](#stuck-ingestion-recovery)).

Embedding concurrency is bounded (default: 5 simultaneous requests) to avoid overwhelming the embedding service on large documents.

### File Ingestion and Chunking

`POST /api/v1/documents/ingest` ingests an already-uploaded file (uploaded via `POST /api/v1/files/upload`). The source format is detected from the file's `content_type`:

| Content type     | How the source text is extracted |
| ---------------- | -------------------------------- |
| `application/pdf`| Parsed page-by-page; blank pages are dropped |
| `text/plain`     | Read as a single source page     |
| `text/markdown`  | Read as a single source page     |

Any other content type is rejected with `UNSUPPORTED_FILE_TYPE` (`400`).

The extracted text is then split into one or more DocumentChunks according to `chunk_strategy`:

- **`chunk_strategy: page`** (default) — one chunk per source page; `page_number` is set on each chunk (PDF only — non-paged sources yield a single chunk).
- **`chunk_strategy: whole`** — a single chunk with all source text joined by newlines.
- **`chunk_strategy: size`** — fixed-size character windows with overlap, controlled by `chunk_size` (default `1000`) and `chunk_overlap` (default `200`). Page attribution is dropped.

The same `chunk_strategy` / `chunk_size` / `chunk_overlap` options are also accepted by `POST /api/v1/documents` (plain text), where the default strategy is `whole`.

Each chunk gets its own embedding vector, enabling fine-grained semantic search that can cite specific page numbers. Embeddings are computed concurrently across chunks, and an embedding failure is non-fatal — the chunk is stored without a vector.

After ingestion completes, `metadata.chunk_count` records the number of chunks created. Note this can differ from the source's `total_pages` (recorded in `metadata`): with `whole` it is always `1`, and with `size` it depends on the text length.

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

For endpoints that accept `project_id`, the field is optional. When omitted, the server resolves accessible projects based on the caller's identity:

| Caller type | Behavior when `project_id` is omitted                                        |
| ----------- | ---------------------------------------------------------------------------- |
| project key | Infers the project from the key's own scope (single project)                 |
| JWT admin   | No project filter — returns results across all projects                      |
| JWT user    | Enumerates all projects the user is a member of with the required permission |

Regular users can only access documents in projects they are members of. Even if a user's policy contains `resource: ["*"]`, the server checks project membership **before** evaluating policies — access is limited to the user's own projects. See [IAM — Authorization Model](iam.md#authorization-model) for the full evaluation flow.

If `project_id` is supplied but the caller lacks permission for that project, the request returns `403 Forbidden`.

## Configuration

| Environment Variable   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `FILES_STORAGE_DIR`    | Yes      | Directory where `.txt` files are written (shared with Files) |
| `EMBEDDING_PROVIDER`   | Yes      | Embedding backend — only `ollama` is supported               |
| `EMBEDDING_MODEL`      | Yes      | Model name, e.g. `qwen3-embedding:0.6b`                      |
| `EMBEDDING_DIMENSIONS` | Yes      | Vector dimensions — must match the model output, e.g. `1024` |
| `OLLAMA_BASE_URL`      | No       | Ollama server URL, defaults to `http://localhost:11434`      |
| `SYNC_INGESTION_MAX_BYTES` | No   | Max file size (bytes) allowed for synchronous ingestion (`?async=false`). Larger files return `413`. Defaults to `10485760` (10 MB). |
| `INGESTION_STALL_TIMEOUT_MS` | No | How long (ms) a document may stay in `pending`/`processing` with no progress before it is auto-failed with `INGESTION_TIMEOUT`. Defaults to `300000` (5 min). |

### Ollama setup example

```bash
# Pull the embedding model
ollama pull qwen3-embedding:0.6b

# Verify it's running
ollama list
```

Set the server environment variables:

```env
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024
OLLAMA_BASE_URL=http://localhost:11434
```

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

First upload the file via `POST /api/v1/files/upload`, then call `POST /api/v1/documents/ingest` with the returned `file_id`. Works for PDFs and `text/*` files alike.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Step 1: upload the file (PDF, .txt, or .md)
FILE_ID=$(soat upload-file \
  --project-id proj_ABC \
  --file ./report.pdf \
  --jq '.id')

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

// Step 3: poll until ready
let doc = data;
while (doc.status === 'pending' || doc.status === 'processing') {
  await new Promise((r) => setTimeout(r, 500));
  const { data: polled } = await soat.documents.getDocument({ path: { document_id: doc.id } });
  doc = polled!;
}
if (doc.status === 'failed') throw new Error(`Ingestion failed: ${(doc.metadata as any)?.failure_reason}`);
console.log(`Ready — ${(doc.metadata as any)?.chunk_count} chunks`);
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
