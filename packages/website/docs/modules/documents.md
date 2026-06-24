import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Documents

The Documents module stores documents with per-chunk embedding vectors for semantic search across project content.

## Overview

A Document is backed by a [File](./files.md) and associated with a project. When a document is created, its content is split into one or more **DocumentChunks** — each chunk has its own embedding vector. This enables cosine-similarity search at query time without an external vector database.

Documents can be created in two ways:

- **Plain text** (`POST /documents`) — the entire content is stored as a single chunk.
- **PDF ingestion** (`POST /documents/from-file`) — an uploaded PDF file is parsed page by page; each non-empty page becomes a separate chunk (configurable via `chunk_strategy`).

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
| `title`      | string \| null | Human-readable title (auto-set to filename for PDF ingestion)                                                      |
| `metadata`   | object \| null | Arbitrary JSON metadata (PDF ingestion sets `source_file_id` and `total_pages`)                                    |
| `tags`       | object \| null | Key-value string tags                                                                                              |
| `content`    | string \| null | Joined chunk content — only present in `GET /documents/:id` responses                                              |
| `created_at` | string         | ISO 8601 creation timestamp                                                                                        |
| `updated_at` | string         | ISO 8601 last-updated timestamp                                                                                    |

### DocumentFromFileRecord (PDF ingestion response only)

Extends Document with:

| Field         | Type   | Description                                         |
| ------------- | ------ | --------------------------------------------------- |
| `chunk_count` | number | Number of chunks (pages) created from the PDF       |

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

### PDF Ingestion and Chunking

`POST /api/v1/documents/from-file` ingests an already-uploaded PDF file. The file must have `content_type: application/pdf` (set automatically when uploading via `POST /api/v1/files/upload` with a `.pdf` file).

The server extracts text page-by-page and creates one Document with multiple DocumentChunks:

- **`chunk_strategy: page`** (default) — one chunk per non-empty page; `page_number` is set on each chunk.
- **`chunk_strategy: whole`** — a single chunk with all pages joined by newlines.

Each chunk gets its own embedding vector, enabling fine-grained semantic search that can cite specific page numbers.

The response includes `chunk_count` — the number of chunks created (i.e., non-empty pages when using the default strategy).

### Path-Based SRNs

Policies can target documents by their logical path rather than their `id`. When a document has a `path` set, the server evaluates **both** the id-based SRN and the path-based SRN:

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

### Ingest a PDF file

First upload the PDF via `POST /api/v1/files/upload`, then call `POST /api/v1/documents/from-file` with the returned `file_id`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Step 1: upload the PDF
FILE_ID=$(soat upload-file \
  --project-id proj_ABC \
  --file ./report.pdf \
  --jq '.id')

# Step 2: ingest — one chunk per page (default)
soat create-documents-from-file \
  --project-id proj_ABC \
  --file-id "$FILE_ID" \
  --path-prefix /reports/
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
const soat = new SoatClient({ baseUrl: 'https://api.example.com', token: 'sk_...' });

// Step 1: upload the PDF
const formData = new FormData();
formData.append('file', pdfBlob, 'report.pdf');
formData.append('project_id', 'proj_ABC');
const { data: file, error: uploadErr } = await soat.files.uploadFile({ body: formData });
if (uploadErr) throw new Error(JSON.stringify(uploadErr));

// Step 2: ingest
const { data, error } = await soat.documents.createDocumentsFromFile({
  body: {
    file_id: file.id,
    project_id: 'proj_ABC',
    path_prefix: '/reports/',
  },
});
if (error) throw new Error(JSON.stringify(error));
console.log(`Created document ${data.id} with ${data.chunk_count} chunks`);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Step 1: upload the PDF
FILE_ID=$(curl -sX POST https://api.example.com/api/v1/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@report.pdf" \
  -F "project_id=proj_ABC" | jq -r '.id')

# Step 2: ingest
curl -X POST https://api.example.com/api/v1/documents/from-file \
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
