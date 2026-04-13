# Documents Module

The Documents module stores plain-text documents along with an embedding vector in PostgreSQL, enabling semantic (vector) search across project content. Under the hood each document is backed by a Files record stored on disk.

## Overview

A Document IS a File — it always uses `.txt` format and is associated with a project. When a document is created, its text content is passed to a configured embedding provider (currently Ollama only), and the resulting vector is stored alongside the text. This allows cosine-similarity search at query time without an external vector database.

Documents are identified by an `id` prefixed with `doc_`. The internal database primary key is never returned.

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
| `fileId`    | string | ID of the underlying File record                              |
| `projectId` | string | ID of the owning project                                      |
| `filename`  | string | Original filename (`.txt` extension)                          |
| `size`      | number | File size in bytes                                            |
| `content`   | string | Text content — only present in `GET /documents/:id` responses |
| `createdAt` | string | ISO 8601 creation timestamp                                   |
| `updatedAt` | string | ISO 8601 last-updated timestamp                               |

The `embedding` column (pgvector `vector(N)`) is stored in the database but never returned via the API.

## Permissions

Document operations are governed by per-project policies. Grant the following permissions:

| Action            | Permission                  | REST Endpoint                   | MCP Tool           |
| ----------------- | --------------------------- | ------------------------------- | ------------------ |
| List documents    | `documents:ListDocuments`   | `GET /api/v1/documents`         | `list-documents`   |
| Get a document    | `documents:GetDocument`     | `GET /api/v1/documents/:id`     | `get-document`     |
| Create a document | `documents:CreateDocument`  | `POST /api/v1/documents`        | `create-document`  |
| Delete a document | `documents:DeleteDocument`  | `DELETE /api/v1/documents/:id`  | `delete-document`  |
| Update a document | `documents:UpdateDocument`  | `PATCH /api/v1/documents/:id`   | `update-document`  |
| Semantic search   | `documents:SearchDocuments` | `POST /api/v1/documents/search` | `search-documents` |

See the [API Reference](../api/documents/list-documents) for full endpoint details, request/response schemas, and status codes.

## Project ID Resolution

For endpoints that accept `projectId`, the field is optional. When omitted, the server resolves accessible projects based on the caller's identity:

| Caller type | Behavior when `projectId` is omitted                                         |
| ----------- | ---------------------------------------------------------------------------- |
| project key | Infers the project from the key's own scope (single project)                 |
| JWT admin   | No project filter — returns results across all projects                      |
| JWT user    | Enumerates all projects the user is a member of with the required permission |

If `projectId` is supplied but the caller lacks permission for that project, the request returns `403 Forbidden`.

## MCP Tools

The following MCP tools are available for AI assistants:

| Tool name          | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `list-documents`   | List documents; omit `projectId` to retrieve all accessible documents      |
| `get-document`     | Retrieve a document including its text content                             |
| `create-document`  | Create a new text document with automatic embedding                        |
| `delete-document`  | Delete a document and its underlying file                                  |
| `update-document`  | Update document content, title, metadata, or tags                          |
| `search-documents` | Semantic search; omit `projectId` to search across all accessible projects |
