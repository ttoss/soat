import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Documents

The Documents module stores plain-text documents with embedding vectors for semantic search across project content.

## Overview

A Document IS a [File](./files.md) — it always uses `.txt` format and is associated with a project. When a document is created, its text content is passed to a configured embedding provider (currently Ollama only), and the resulting vector is stored alongside the text. This allows cosine-similarity search at query time without an external vector database.

Documents are identified by an `id` prefixed with `doc_`. The internal database primary key is never returned.

See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

| Field        | Type           | Description                                                                                                        |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`         | string         | Public identifier prefixed with `doc_`                                                                             |
| `file_id`    | string         | ID of the underlying File record                                                                                   |
| `project_id` | string         | ID of the owning project                                                                                           |
| `path`       | string \| null | Logical path within the project (e.g. `/reports/q1.txt`). Also used as the resource ID segment in path-based SRNs. |
| `filename`   | string         | Original filename (`.txt` extension)                                                                               |
| `size`       | number         | File size in bytes                                                                                                 |
| `content`    | string         | Text content — only present in `GET /documents/:id` responses                                                      |
| `created_at` | string         | ISO 8601 creation timestamp                                                                                        |
| `updated_at` | string         | ISO 8601 last-updated timestamp                                                                                    |

The `embedding` column (pgvector `vector(N)`) is stored in the database but never returned via the API.

### Path Field

The `path` field is a logical, project-scoped identifier for a document — similar to a file path in a filesystem. It is optional at creation time; if omitted, the server defaults to `/<filename>`. Paths must be absolute (start with `/`) and are normalized (`.` and `..` are resolved). The combination of `project_id + path` is unique within a project.

Path examples:

```
/reports/q1.txt
/datasets/raw/2024-01-01.txt
```

`PATCH /documents/:id` accepts a `path` field to move a document to a new logical path.

## Key Concepts

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

### Changing the embedding model after first run

`EMBEDDING_DIMENSIONS` must match the vector width of the `documents.embedding` column that was created when the database was first initialised. If you change the model to one that produces a different number of dimensions (for example, switching from `qwen3-embedding:0.6b` with 1024 dimensions to `nomic-embed-text` with 768 dimensions), all writes that involve an embedding will fail with a database error such as:

```
ERROR: expected 768 dimensions, not 1024
```

This error surfaces as a `500 Internal Server Error` on any endpoint that creates or updates documents or conversation messages.

#### How to migrate

Stop the server, then run the following SQL against your database (replace `768` with the actual dimensions of the new model):

```sql
ALTER TABLE documents DROP COLUMN embedding;
ALTER TABLE documents ADD COLUMN embedding vector(768);
```

Restart the server with the updated `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` values. Existing documents will no longer have embeddings — re-create them or re-upload the content so embeddings are generated with the new model.

:::warning
Dropping the `embedding` column removes all stored vectors. Semantic search results will be empty until documents have been re-embedded with the new model.
:::

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

### Search documents semantically

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-documents --project-id proj_ABC --query "quarterly revenue" --limit 5
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// SDK
const { data, error } = await soat.documents.searchDocuments({
  body: { project_id: 'proj_ABC', query: 'quarterly revenue', limit: 5 },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/documents/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_ABC",
    "query": "quarterly revenue",
    "limit": 5
  }'
```

</TabItem>
</Tabs>
