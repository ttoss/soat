# Documents Module

The Documents module stores plain-text documents along with an embedding vector in PostgreSQL, enabling semantic (vector) search across project content. Under the hood each document is backed by a Files record stored on disk.

## Overview

A Document IS a File — it always uses `.txt` format and is associated with a project. When a document is created, its text content is passed to a configured embedding provider (currently Ollama only), and the resulting vector is stored alongside the text. This allows cosine-similarity search at query time without an external vector database.

Documents are identified by `publicId` prefixed with `doc_`. The internal database primary key is never returned.

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

## Data Model

| Field       | Type   | Description                                                   |
| ----------- | ------ | ------------------------------------------------------------- |
| `id`        | string | Public identifier prefixed with `doc_`                        |
| `fileId`    | string | Public ID of the underlying File record                       |
| `projectId` | string | Public ID of the owning project                               |
| `filename`  | string | Original filename (`.txt` extension)                          |
| `size`      | number | File size in bytes                                            |
| `content`   | string | Text content — only present in `GET /documents/:id` responses |
| `createdAt` | string | ISO 8601 creation timestamp                                   |
| `updatedAt` | string | ISO 8601 last-updated timestamp                               |

The `embedding` column (pgvector `vector(N)`) is stored in the database but never returned via the API.

## Permissions

Document operations are governed by per-project policies. Grant the following permissions:

| Action            | Permission string           |
| ----------------- | --------------------------- |
| List documents    | `documents:ListDocuments`   |
| Get a document    | `documents:GetDocument`     |
| Create a document | `documents:CreateDocument`  |
| Delete a document | `documents:DeleteDocument`  |
| Semantic search   | `documents:SearchDocuments` |

## Operations

### List documents

Returns all documents in a project (no content field):

```http
GET /api/v1/documents?projectId=proj_xxx
Authorization: Bearer <token>
```

### Get a document

Returns the document record including its full text `content`:

```http
GET /api/v1/documents/doc_xxx
Authorization: Bearer <token>
```

### Create a document

Writes the text to disk, generates an embedding, and persists both:

```http
POST /api/v1/documents
Authorization: Bearer <token>
Content-Type: application/json

{
  "projectId": "proj_xxx",
  "content": "The quick brown fox jumps over the lazy dog.",
  "filename": "my-doc.txt"
}
```

### Delete a document

Deletes the Document record, the underlying File record, and removes the file from disk:

```http
DELETE /api/v1/documents/doc_xxx
Authorization: Bearer <token>
```

### Semantic search

Embeds the query and returns the closest documents by cosine distance:

```http
POST /api/v1/documents/search
Authorization: Bearer <token>
Content-Type: application/json

{
  "projectId": "proj_xxx",
  "query": "What is the capital of France?",
  "limit": 5
}
```

The `limit` field defaults to `10` when omitted.

## MCP Tools

The following MCP tools are available for AI assistants:

| Tool name          | Description                                         |
| ------------------ | --------------------------------------------------- |
| `list-documents`   | List all documents in a project                     |
| `get-document`     | Retrieve a document including its text content      |
| `create-document`  | Create a new text document with automatic embedding |
| `delete-document`  | Delete a document and its underlying file           |
| `search-documents` | Semantic search over project documents              |
